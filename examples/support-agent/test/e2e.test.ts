// End-to-end checks of docs/mvp.md "Done looks like", against the real support
// agent under `eve dev`, the local fakes and scripted models. No network, no cost.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "eve/client";
import { api, APP_DIR, childEnv, freePort, startStack, TICKET, waitFor, type Stack } from "../scripts/harness.ts";

type Row = { rowId: string; tool: string; summary: string; state: string; reviewVerdict: string | null; reviewReason: string | null; sessionId: string; current?: unknown };

let stack: Stack;
const rows = () => api<Row[]>(stack, "/undo/api/rows");
const rowsOf = async (sessionId: string) => (await rows()).filter((r) => r.sessionId === sessionId);
const ask = async (message: string) => {
  const { session, delivery } = await stack.client.sessions.create({ message });
  const result = await delivery.result();
  return { session, result, sessionId: result.sessionId as string };
};

beforeAll(async () => {
  stack = await startStack({ hold: "6s" });
});
afterAll(async () => {
  await stack?.stop();
});

describe("the support agent on fakes", () => {
  it("#3 #4 #5 #6 #8: Alice's ticket, unattended; redirect, review, holds, sentence undo, Undo button", async () => {
    const { result, sessionId } = await ask(TICKET);
    expect(result.status).toBe("completed");
    const r = await rowsOf(sessionId);
    const by = (tool: string, re: RegExp) => r.find((x) => x.tool === tool && re.test(x.summary))!;

    // #3: no call waits for a person, and a read gets a row with no reviewer call.
    expect(r.some((x) => x.state === "awaiting_person")).toBe(false);
    const read = by("stripe__list_payment_intents", /./);
    expect(read).toMatchObject({ state: "done", reviewVerdict: null });

    // #4: a direct MCP write with an adapter is denied with the adapter's name; one with no adapter is recorded as irreversible.
    expect(by("stripe__create_refund", /pi_bob/)).toMatchObject({ state: "blocked", reviewReason: expect.stringMatching(/^use undo__stripe_refund/) });
    expect(by("stripe__create_coupon", /10/)).toMatchObject({ state: "irreversible" });
    expect(r.some((x) => x.tool === "undo__stripe_refund")).toBe(true); // the agent then used the adapter

    // #5: the reviewer blocks the wrong-customer refund; Stripe never sees it.
    expect(by("undo__stripe_refund", /pi_bob/)).toMatchObject({ state: "blocked", reviewReason: expect.stringMatching(/customer doesn't match/) });

    // #8: one sentence undoes exactly the email to Bob; a vague one gets a question.
    const email = by("undo__resend_send", /bob@/);
    const plan = await api(stack, "/undo/api/plan", { sentence: "cancel the email to Bob" });
    expect(plan.rows.map((x: Row) => x.rowId)).toEqual([email.rowId]);
    expect((await api(stack, `/undo/api/plan/${plan.planId}/confirm`, {})).results).toEqual([{ status: "cancelled", rowId: email.rowId }]);
    const vague = await api(stack, "/undo/api/plan", { sentence: "undo it" });
    expect(vague.question).toBeTruthy();
    expect(vague.planId).toBeUndefined();

    // #6: the Undo button during the hold: no refund in Stripe, and the email never sends.
    const refund = by("undo__stripe_refund", /pi_alice/);
    expect(refund.state).toBe("held");
    expect(await api(stack, `/undo/api/rows/${refund.rowId}/undo`, {})).toEqual({ status: "cancelled", rowId: refund.rowId });
    await new Promise((res) => setTimeout(res, 7000));
    await rows(); // sweeps
    expect(stack.fakes.fakes.listRefunds()).toEqual([]);
    expect(stack.fakes.fakes.state.log.some((l) => l.path.endsWith("/refunds"))).toBe(false);
    const sent = Object.values(stack.fakes.fakes.state.emails).filter((e) => e.to[0] === "bob@example.com");
    expect(sent.map((e) => e.last_event)).toEqual(["canceled"]);
  });

  it("#10: the agent undoes its own email with undo__undo", async () => {
    const { result, sessionId } = await ask("Email Bob about his order, then take it back.");
    expect(result.reply).toMatch(/"status":"cancelled"/);
    const r = await rowsOf(sessionId);
    expect(r.find((x) => x.tool === "undo__resend_send")!.state).toBe("cancelled");
    expect(r.find((x) => x.tool === "undo__undo")!.state).toBe("done");
    const email = Object.values(stack.fakes.fakes.state.emails).find((e) => e.subject === "Order update")!;
    expect(email.last_event).toBe("canceled");
  });

  it("#9: reversible(): undo reverses a clean credit; a hand edit after it is a conflict and is kept", async () => {
    const first = await ask("Please give Alice $5 store credit.");
    const clean = (await rowsOf(first.sessionId)).find((x) => x.tool === "issue_credit")!;
    expect(clean.state).toBe("done");
    expect(stack.fakes.fakes.customer("cus_alice").balance).toBe(-500);
    expect(await api(stack, `/undo/api/rows/${clean.rowId}/undo`, {})).toEqual({ status: "undone", rowId: clean.rowId });
    expect(stack.fakes.fakes.customer("cus_alice").balance).toBe(0);

    const second = await ask("Please give Alice $5 store credit.");
    const edited = (await rowsOf(second.sessionId)).find((x) => x.tool === "issue_credit")!;
    await fetch(`${stack.fakes.url}/_admin/stripe/customers/cus_alice/balance_transactions`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "amount=-200&description=hand+edit",
    });
    const result = await api(stack, `/undo/api/rows/${edited.rowId}/undo`, {});
    expect(result.status).toBe("conflict");
    expect(stack.fakes.fakes.customer("cus_alice").balance).toBe(-700);
    expect((await rows()).find((x) => x.rowId === edited.rowId)!.state).toBe("conflict");
  });

  it("#12: approve 'human' parks the call with no review; after a person approves, it runs once", async () => {
    const { session, result, sessionId } = await ask("Please give Alice a 100% coupon.");
    expect(result.status).toBe("awaiting-input");
    const parked = (await rowsOf(sessionId)).filter((x) => x.tool === "stripe__create_coupon");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ state: "awaiting_person", reviewVerdict: null });
    const interaction: any = result.interactions[0];
    const resumed = await session.respond([{ interactionId: interaction.interactionId ?? interaction.id, optionId: "approve" }]);
    const done = await resumed.result();
    expect(done.status).toBe("completed");
    const after = (await rowsOf(sessionId)).filter((x) => x.tool === "stripe__create_coupon");
    expect(after).toHaveLength(1);
    expect(after[0]!.state).toBe("irreversible");
    expect(stack.fakes.fakes.state.coupons.filter((c) => c.percent_off === 100)).toHaveLength(1);
  });

  it("#11: a restart during a hold runs the held action exactly once; a reversible() row is undone before any new turn", async () => {
    const credit = await ask("Please give Alice $5 store credit.");
    const creditRow = (await rowsOf(credit.sessionId)).find((x) => x.tool === "issue_credit")!;
    const ticket = await ask(TICKET);
    const refund = (await rowsOf(ticket.sessionId)).find((x) => x.tool === "undo__stripe_refund" && /pi_alice/.test(x.summary))!;
    expect(refund.state).toBe("held");

    await stack.stopAgent();
    await new Promise((res) => setTimeout(res, 7000)); // the hold ends while the agent is down
    expect(stack.fakes.fakes.listRefunds("pi_alice")).toHaveLength(0);
    await stack.restart();

    const balance = stack.fakes.fakes.customer("cus_alice").balance;
    expect(await api(stack, `/undo/api/rows/${creditRow.rowId}/undo`, {})).toEqual({ status: "undone", rowId: creditRow.rowId });
    expect(stack.fakes.fakes.customer("cus_alice").balance).toBe(balance + 500);

    await waitFor(async () => (await rows()).find((x) => x.rowId === refund.rowId)?.state === "irreversible", 30_000, "the refund to run");
    await rows();
    expect(stack.fakes.fakes.listRefunds("pi_alice")).toHaveLength(1);
    expect(stack.fakes.fakes.listRefunds("pi_bob")).toHaveLength(0);
  });
});

describe("#2: a fresh eve agent with undo-eve plus the two files", () => {
  it("passes eve build, records a row and logs its plain tool as a write", async () => {
    const dir = join(APP_DIR, "../fresh-agent");
    execFileSync(join(dir, "node_modules/.bin/eve"), ["build"], { cwd: dir, stdio: "pipe", env: childEnv({}) });
    const port = await freePort();
    const ledger = join(mkdtempSync(join(tmpdir(), "undo-fresh-")), "ledger.db");
    const child = spawn(join(dir, "node_modules/.bin/eve"), ["dev", "--no-ui", "--port", String(port)], {
      cwd: dir,
      env: childEnv({ UNDO_LEDGER: ledger, NO_COLOR: "1" }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    try {
      await waitFor(async () => /ready at/.test(out), 120_000, "eve dev");
      const client = new Client({ baseUrl: `http://127.0.0.1:${port}` });
      const { delivery } = await client.sessions.create({ message: "Where is order 1001?" });
      expect((await delivery.result()).reply).toMatch(/shipped/);
      const r: Row[] = await (await fetch(`http://127.0.0.1:${port}/undo/api/rows`)).json();
      expect(r.find((x) => x.tool === "lookup_order")).toMatchObject({ state: "irreversible", reviewVerdict: "approve" });
      expect(out).toMatch(/reviewing lookup_order as a write/);
    } finally {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
    }
  });
});
