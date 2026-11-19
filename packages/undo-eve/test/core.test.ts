import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakes, type FakesServer } from "undo-fakes";
import {
  classify,
  confirmPlan,
  decide,
  getStore,
  keywordMatch,
  planUndo,
  registerReversible,
  resendSend,
  rowForCall,
  makeCtx,
  setConfig,
  stripeCapture,
  stripeRefund,
  sweep,
  undoRow,
  type ReviewFn,
  type UndoConfig,
} from "../extension/lib/index.ts";

let fakes: FakesServer;
let n = 0;
const reviews: string[] = [];
let reviewMode: "script" | "throw" = "script";

// The scripted reviewer: block a refund whose payment intent names someone the
// session's messages never mention.
const review: ReviewFn = (call, context) => {
  reviews.push(call.toolName);
  if (reviewMode === "throw") throw new Error("gateway down");
  const pi = (call.input as any)?.payment_intent as string | undefined;
  const who = pi?.replace(/^pi_/, "");
  if (who && !context.messages.join(" ").toLowerCase().includes(who)) {
    return { verdict: "block", reason: "customer doesn't match the ticket" };
  }
  return { verdict: "approve", reason: "matches the ticket" };
};

function config(extra: Partial<UndoConfig> = {}): UndoConfig {
  return {
    hold: 300,
    adapters: { stripe: "stripe", resend: "resend" },
    services: {
      stripe: { baseUrl: `${fakes.url}/stripe`, token: "sk_test_fake" },
      resend: { baseUrl: `${fakes.url}/resend`, token: "re_test_fake" },
    },
    review,
    match: keywordMatch,
    store: { path: join(mkdtempSync(join(tmpdir(), "undo-test-")), "ledger.db") },
    ...extra,
  };
}

const session = (id = "s1") => ({ id });
const ctxFor = (toolName: string, sessionId = "s1") => ({ session: session(sessionId), callId: `c${++n}`, toolName });
async function call(toolName: string, toolInput: unknown, sessionId = "s1") {
  const ctx = ctxFor(toolName, sessionId);
  const status = await decide({ ...ctx, toolInput });
  return { ctx, status };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripeLog = () => fakes.fakes.state.log.filter((l) => l.service === "stripe" && l.method === "POST");

beforeAll(async () => {
  fakes = await startFakes();
});
afterAll(async () => {
  await fakes.close();
});
beforeEach(async () => {
  fakes.fakes.reset();
  reviews.length = 0;
  reviewMode = "script";
  setConfig(config());
  (await getStore()).addMessage("s1", "Hi, this is Alice. Please refund my order pi_alice.");
});

describe("classify (precedence)", () => {
  it("sorts calls by the first matching rule", () => {
    const cfg = setConfig(config({ reads: ["crm__lookup"], subagents: ["researcher"], approve: { notify: "human" } }));
    expect(classify(cfg, { toolName: "undo__history" }).kind).toBe("undo");
    expect(classify(cfg, { toolName: "undo__stripe_refund" })).toMatchObject({ kind: "adapter", strategy: "cancel", approve: "agent" });
    expect(classify(cfg, { toolName: "stripe__create_refund" })).toMatchObject({ kind: "deny", reason: expect.stringMatching(/^use undo__stripe_refund; it can be undone for 300ms/) });
    expect(classify(cfg, { toolName: "stripe__retrieve_customer" }).kind).toBe("read");
    expect(classify(cfg, { toolName: "other__thing", toolAnnotations: { readOnlyHint: true } }).kind).toBe("read");
    expect(classify(cfg, { toolName: "crm__lookup" }).kind).toBe("read");
    expect(classify(cfg, { toolName: "bash" })).toMatchObject({ kind: "sandbox", approve: "none" });
    expect(classify(cfg, { toolName: "researcher" })).toMatchObject({ kind: "subagent", approve: "none" });
    expect(classify(cfg, { toolName: "stripe__create_coupon" })).toMatchObject({ kind: "write", strategy: "none", approve: "agent" });
    expect(classify(cfg, { toolName: "notify" })).toMatchObject({ kind: "write", approve: "human" });
  });
});

describe("undoPolicy", () => {
  it("denies a direct write an adapter covers, with the adapter's name", async () => {
    const { ctx, status } = await call("stripe__create_refund", { payment_intent: "pi_bob" });
    expect(status).toMatchObject({ type: "denied", reason: expect.stringMatching(/^use undo__stripe_refund; it can be undone for 300ms/) });
    const row = (await getStore()).getByCall("s1", ctx.callId)!;
    expect(row.state).toBe("blocked");
  });

  it("runs reads and sandbox calls with no review", async () => {
    expect((await call("stripe__retrieve_customer", { customer: "cus_alice" })).status).toBeUndefined();
    expect((await call("bash", { command: "ls" })).status).toBeUndefined();
    expect(reviews).toEqual([]);
  });

  it("reviews before the call and blocks the wrong customer", async () => {
    const bob = await call("undo__stripe_refund", { payment_intent: "pi_bob" });
    expect(bob.status).toEqual({ type: "denied", reason: "blocked by reviewer: customer doesn't match the ticket" });
    const alice = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
    expect(alice.status).toBe("approved");
    expect(reviews).toEqual(["undo__stripe_refund", "undo__stripe_refund"]);
  });

  it("never asks a person by default, and caps retries when review is down", async () => {
    reviewMode = "throw";
    const a = await call("stripe__create_coupon", { percent_off: 10 });
    const b = await call("stripe__create_coupon", { percent_off: 10 });
    expect(a.status).toEqual({ type: "denied", reason: "review unavailable, try once more" });
    expect(b.status).toEqual({ type: "denied", reason: "review unavailable; don't retry, report it" });
    const rows = (await getStore()).list();
    expect(rows.some((r) => r.state === "awaiting_person")).toBe(false);
  });

  it("asks a person only for approve: human, and doesn't review again on the recheck", async () => {
    setConfig(config({ approve: { stripe__create_coupon: "human" } }));
    const { ctx, status } = await call("stripe__create_coupon", { percent_off: 10 });
    expect(status).toBe("user-approval");
    expect(await decide({ ...ctx, toolInput: { percent_off: 10 } })).toBe("approved");
    expect(reviews).toEqual([]);
    expect((await getStore()).list()).toHaveLength(1);
  });
});

describe("cancel strategy", () => {
  it("holds a refund for the full hold, then sends it once", async () => {
    const { ctx } = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
    const result = await stripeRefund(ctx, { payment_intent: "pi_alice" });
    expect(result.status).toBe("scheduled");
    expect(fakes.fakes.listRefunds("pi_alice")).toHaveLength(0);
    await sleep(500);
    await sweep();
    expect(fakes.fakes.listRefunds("pi_alice")).toHaveLength(1);
    expect((await getStore()).get(result.rowId)!.state).toBe("irreversible");
  });

  it("undo during the hold: Stripe never sees the refund", async () => {
    const { ctx } = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
    const { rowId } = await stripeRefund(ctx, { payment_intent: "pi_alice" });
    expect(await undoRow(rowId)).toEqual({ status: "cancelled", rowId });
    await sleep(500);
    await sweep();
    expect(fakes.fakes.listRefunds("pi_alice")).toHaveLength(0);
    expect(stripeLog().filter((l) => l.path.endsWith("/refunds"))).toHaveLength(0);
    expect(await undoRow(rowId)).toEqual({ status: "cancelled", rowId });
  });

  it("checks the refund would be accepted before scheduling it", async () => {
    const { ctx } = await call("undo__stripe_refund", { payment_intent: "pi_alice", amount: 999999 });
    await expect(stripeRefund(ctx, { payment_intent: "pi_alice", amount: 999999 })).rejects.toThrow(/can still be refunded/);
  });

  it("cancels a held email at Resend; after the hold it is final", async () => {
    const a = await call("undo__resend_send", { to: "bob@example.com", subject: "Refund", text: "x" });
    const held = await resendSend(a.ctx, { to: "bob@example.com", subject: "Refund", text: "x" });
    const b = await call("undo__resend_send", { to: "alice@example.com", subject: "Refund", text: "y" });
    const kept = await resendSend(b.ctx, { to: "alice@example.com", subject: "Refund", text: "y" });
    expect((await undoRow(held.rowId)).status).toBe("cancelled");
    await sleep(600);
    await sweep();
    const emails = Object.values(fakes.fakes.state.emails);
    expect(emails.find((e) => e.to[0] === "bob@example.com")!.last_event).toBe("canceled");
    expect(emails.find((e) => e.to[0] === "alice@example.com")!.last_event).toBe("delivered");
    const after = await undoRow(kept.rowId);
    expect(after.status).toBe("irreversible");
    expect((after as any).followUp).toMatch(/correction/);
  });
});

describe("reverse strategy", () => {
  it("undo after a capture: exactly one refund, even when undo runs twice", async () => {
    (await getStore()).addMessage("s1", "Carol (pi_carol) asked us to capture her boots.");
    const { ctx } = await call("undo__stripe_capture", { payment_intent: "pi_carol" });
    const { rowId } = await stripeCapture(ctx, { payment_intent: "pi_carol" });
    const [a, b] = await Promise.all([undoRow(rowId), undoRow(rowId)]);
    expect([a.status, b.status].sort()).toEqual(["not_allowed", "undone"].sort());
    expect((await undoRow(rowId)).status).toBe("undone");
    expect(fakes.fakes.listRefunds("pi_carol")).toHaveLength(1);
    expect(fakes.fakes.listRefunds("pi_carol")[0]!.amount).toBe(5000);
  });

  it("a retried inverse replays through the idempotency key", async () => {
    (await getStore()).addMessage("s1", "Carol (pi_carol) asked us to capture her boots.");
    const { ctx } = await call("undo__stripe_capture", { payment_intent: "pi_carol" });
    const { rowId } = await stripeCapture(ctx, { payment_intent: "pi_carol" });
    const store = await getStore();
    // Simulate a crash after the refund reached Stripe but before the row said so.
    await fetch(`${fakes.url}/stripe/v1/refunds`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/x-www-form-urlencoded", "idempotency-key": `undo-${rowId}-undo` },
      body: "payment_intent=pi_carol&amount=5000",
    });
    store.update(rowId, { ref: { undoStarted: true } });
    expect((await undoRow(rowId)).status).toBe("undone");
    expect(fakes.fakes.listRefunds("pi_carol")).toHaveLength(1);
  });

  it("someone else's refund after the capture is a conflict, and it is kept", async () => {
    (await getStore()).addMessage("s1", "Carol (pi_carol) asked us to capture her boots.");
    const { ctx } = await call("undo__stripe_capture", { payment_intent: "pi_carol" });
    const { rowId } = await stripeCapture(ctx, { payment_intent: "pi_carol" });
    fakes.fakes.createRefund({ payment_intent: "pi_carol", amount: 1000 });
    const result = await undoRow(rowId);
    expect(result.status).toBe("conflict");
    expect(fakes.fakes.listRefunds("pi_carol")).toHaveLength(1);
  });

  it("reversible(): a hand edit after the agent's write shows as a conflict and is kept", async () => {
    const base = `${fakes.url}/stripe/v1/customers`;
    const headers = { authorization: "Bearer x", "content-type": "application/x-www-form-urlencoded" };
    registerReversible({
      name: "issue_credit",
      description: "Give store credit.",
      approve: "none",
      do: async (input: any, rctx) => {
        const r = await fetch(`${base}/${input.customer}/balance_transactions`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": rctx.idempotencyKey },
          body: `amount=${-input.cents}&description=credit`,
        });
        return { changeId: (await r.json()).id };
      },
      undo: async (input: any, result: any, rctx) => {
        const list = await (await fetch(`${base}/${input.customer}/balance_transactions`, { headers })).json();
        if (list.data[0]?.id !== result.changeId) return rctx.conflict({ latest: list.data[0] });
        await fetch(`${base}/${input.customer}/balance_transactions`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": rctx.idempotencyKey },
          body: `amount=${input.cents}&description=undo credit`,
        });
      },
    });
    const run = async () => {
      const { ctx } = await call("issue_credit", { customer: "cus_alice", cents: 500 });
      const { store, row } = await rowForCall(ctx, { customer: "cus_alice", cents: 500 }, { kind: "reversible", strategy: "reverse", summary: "credit" });
      const { getReversible } = await import("../extension/lib/registry.ts");
      const out = await getReversible("issue_credit")!.do({ customer: "cus_alice", cents: 500 }, makeCtx(row.rowId, "do"));
      store.update(row.rowId, { output: out });
      store.transition(row.rowId, "requested", "done");
      return row.rowId;
    };
    const clean = await run();
    expect((await undoRow(clean)).status).toBe("undone");
    expect(fakes.fakes.customer("cus_alice").balance).toBe(0);

    const edited = await run();
    fakes.fakes.createBalanceTransaction("cus_alice", { amount: -200, description: "hand edit" });
    const result = await undoRow(edited);
    expect(result.status).toBe("conflict");
    expect(fakes.fakes.customer("cus_alice").balance).toBe(-700);
  });
});

describe("undo in one sentence", () => {
  it('"cancel the email to Bob" undoes exactly that row; "undo it" asks', async () => {
    const r1 = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
    const refund = await stripeRefund(r1.ctx, { payment_intent: "pi_alice" });
    const r2 = await call("undo__resend_send", { to: "bob@example.com", subject: "Your refund", text: "x" });
    const email = await resendSend(r2.ctx, { to: "bob@example.com", subject: "Your refund", text: "x" });

    const vague = await planUndo("undo it");
    expect("question" in vague && vague.candidates.map((c) => c.rowId).sort()).toEqual([refund.rowId, email.rowId].sort());

    const plan = await planUndo("cancel the email to Bob");
    expect("planId" in plan && plan.rows.map((r) => r.rowId)).toEqual([email.rowId]);
    const done = await confirmPlan((plan as any).planId);
    expect(done).toEqual({ results: [{ status: "cancelled", rowId: email.rowId }] });
    expect(await confirmPlan((plan as any).planId)).toEqual({ error: "this plan already ran" });
    expect((await getStore()).get(refund.rowId)!.state).toBe("held");
  });
});

describe("restart", () => {
  it("a hold that came due while the process was down runs exactly once", async () => {
    const { ctx } = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
    const { rowId } = await stripeRefund(ctx, { payment_intent: "pi_alice" });
    // Forget timers, as a new process would.
    const sh = (globalThis as any)[Symbol.for("undo-eve.runtime")];
    for (const t of sh.timers.values()) clearTimeout(t);
    sh.timers.clear();
    await sleep(400);
    await Promise.all([sweep(), sweep(), sweep()]);
    expect(fakes.fakes.listRefunds("pi_alice")).toHaveLength(1);
    expect((await getStore()).get(rowId)!.state).toBe("irreversible");
  });
});

describe("lease", () => {
  it("a row stranded in running is finished by the next sweep with the same idempotency key", async () => {
    process.env.UNDO_LEASE_MS = "50";
    try {
      const { ctx } = await call("undo__stripe_refund", { payment_intent: "pi_alice" });
      const { rowId } = await stripeRefund(ctx, { payment_intent: "pi_alice" });
      const store = await getStore();
      const sh = (globalThis as any)[Symbol.for("undo-eve.runtime")];
      for (const t of sh.timers.values()) clearTimeout(t);
      sh.timers.clear();
      await sleep(350);
      // A worker claimed the hold, sent the refund, then died before recording it.
      const row = store.transition(rowId, "held", "running", { ref: { claim: "run" } })!;
      await fetch(`${fakes.url}/stripe/v1/refunds`, {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/x-www-form-urlencoded", "idempotency-key": `undo-${rowId}-do` },
        body: new URLSearchParams({ payment_intent: "pi_alice", amount: String(row.action.params.amount) }).toString(),
      });
      await sleep(100);
      await Promise.all([sweep(), sweep()]);
      expect(fakes.fakes.listRefunds("pi_alice")).toHaveLength(1);
      expect(store.get(rowId)!.state).toBe("irreversible");
    } finally {
      delete process.env.UNDO_LEASE_MS;
    }
  });
});

describe("not mounted", () => {
  it("undoPolicy denies every call with a clear message when undo() never ran", async () => {
    const key = Symbol.for("undo-eve.config");
    const saved = (globalThis as any)[key];
    delete (globalThis as any)[key];
    try {
      const status = await decide({ ...ctxFor("anything"), toolInput: {} });
      expect(status).toMatchObject({ type: "denied", reason: expect.stringContaining("undo-eve/agent") });
    } finally {
      (globalThis as any)[key] = saved;
    }
  });
});
