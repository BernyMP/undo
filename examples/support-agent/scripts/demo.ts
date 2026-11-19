// pnpm demo [--keep]
//
// Runs the spec's demo end to end on one machine: fake Stripe and Resend, a
// scripted support agent, a scripted reviewer. Nothing leaves this machine and
// nothing costs money. Exits 0 when every check passes.

import { api, startStack, TICKET, waitFor } from "./harness.ts";

const keep = process.argv.includes("--keep");
const HOLD = process.env.UNDO_HOLD ?? "20s";
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};
const say = (s = "") => console.log(s);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Row = { rowId: string; tool: string; summary: string; state: string; reviewReason: string | null; undoUntil: number | null; sessionId: string };

say(c.bold("undo demo") + c.dim(": a shop's support agent on fake Stripe and Resend. Scripted models; nothing leaves this machine."));
say();
say(c.dim("Starting fake Stripe and Resend, and the agent under eve dev..."));
const stack = await startStack({ hold: HOLD, fakesPort: process.env.FAKES_PORT ? Number(process.env.FAKES_PORT) : undefined, agentPort: process.env.PORT ? Number(process.env.PORT) : undefined });
say(`  fakes:       ${stack.fakes.url}  ${c.dim("(request log: /_log)")}`);
say(`  agent:       ${stack.url}`);
say(`  ledger page: ${c.bold(stack.url + "/undo")}`);
say(`  hold:        ${HOLD}`);
say();

let failed = false;
const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean) => {
  checks.push([label, ok]);
  if (!ok) failed = true;
};

try {
  // Step 1 and 2: the ticket, unattended.
  say(c.bold("Step 1-2. Alice's ticket arrives. No person is watching."));
  say(`  ${c.dim("customer:")} "${TICKET}"`);
  const { delivery } = await stack.client.sessions.create({ message: TICKET });
  const result = await delivery.result();
  const rows = (await api<Row[]>(stack, "/undo/api/rows")).slice().reverse();
  for (const r of rows) {
    const state =
      r.state === "blocked" ? c.red(r.state) : r.state === "held" ? c.yellow(`held until ${new Date(r.undoUntil!).toLocaleTimeString()}`) : c.green(r.state);
    say(`  ${c.dim(r.rowId.padEnd(4))} ${r.tool.padEnd(30)} ${r.summary.slice(0, 48).padEnd(48)} ${state}`);
    if (r.state === "blocked" && r.reviewReason) say(`       ${c.dim("↳ " + r.reviewReason)}`);
  }
  say(`  ${c.dim("agent replies:")} "${result.reply}"`);
  check("the agent's turn finished without waiting for a person", result.status === "completed" && !rows.some((r) => r.state === "awaiting_person"));
  check("the direct Stripe refund was redirected to undo__stripe_refund", rows.some((r) => r.tool === "stripe__create_refund" && r.state === "blocked" && /undo__stripe_refund/.test(r.reviewReason ?? "")));
  check("the reviewer blocked the refund to Bob", rows.some((r) => r.tool === "undo__stripe_refund" && /pi_bob/.test(r.summary) && r.state === "blocked"));
  const bobEmail = rows.find((r) => r.tool === "undo__resend_send" && /bob@/.test(r.summary));
  const aliceRefund = rows.find((r) => r.tool === "undo__stripe_refund" && /pi_alice/.test(r.summary));
  check("Alice's refund and the email to Bob are held", bobEmail?.state === "held" && aliceRefund?.state === "held");
  say();

  // Step 3: a person types one sentence on the ledger page (played through the page's API).
  say(c.bold('Step 3. Someone types "cancel the email to Bob" on the ledger page.'));
  const plan = await api(stack, "/undo/api/plan", { sentence: "cancel the email to Bob" });
  if (plan.planId) {
    say(`  plan: ${plan.rows.map((r: Row) => `${r.rowId} ${r.summary}`).join(", ")}`);
    const done = await api(stack, `/undo/api/plan/${plan.planId}/confirm`, {});
    say(`  confirm → ${done.results.map((x: any) => `${x.rowId} ${c.green(x.status)}`).join(", ")}`);
    check("the sentence matched exactly the email to Bob", plan.rows.length === 1 && plan.rows[0].rowId === bobEmail?.rowId);
  } else {
    say(`  ${c.red("no plan:")} ${plan.question}`);
    check("the sentence matched exactly the email to Bob", false);
  }
  const vague = await api(stack, "/undo/api/plan", { sentence: "undo it" });
  say(`  ${c.dim('"undo it" →')} ${vague.question} ${c.dim(`(${vague.candidates?.length ?? 0} candidates)`)}`);
  check('a vague sentence ("undo it") gets a question', Boolean(vague.question) && !vague.planId);
  say();

  // Step 4: the refund's hold ends.
  say(c.bold(`Step 4. Waiting for Alice's refund hold to end (${HOLD})...`));
  const final = await waitFor(
    async () => {
      const all = await api<Row[]>(stack, "/undo/api/rows");
      const r = all.find((x) => x.rowId === aliceRefund?.rowId);
      return r && r.state !== "held" && r.state !== "running" ? all : undefined;
    },
    120_000,
    "Alice's refund to leave its hold",
  );
  const refundRow = final.find((x) => x.rowId === aliceRefund?.rowId)!;
  say(`  ${refundRow.rowId} ${refundRow.summary} → ${c.green(refundRow.state)} ${c.dim("(sent to Stripe; final now)")}`);
  say();

  // The ledger and the fakes' own records.
  say(c.bold("The ledger") + c.dim(` (${stack.url}/undo)`));
  for (const r of final.slice().reverse()) {
    say(`  ${c.dim(r.rowId.padEnd(4))} ${r.tool.padEnd(30)} ${r.summary.slice(0, 48).padEnd(48)} ${r.state}${r.reviewReason ? c.dim("  · " + r.reviewReason) : ""}`);
  }
  say();
  const refunds = stack.fakes.fakes.listRefunds();
  const emails = Object.values(stack.fakes.fakes.state.emails);
  say(c.bold("What the fake services saw"));
  say(`  Stripe refunds: ${refunds.map((r) => `${r.payment_intent} ${money(r.amount)}`).join(", ") || "none"}`);
  say(`  Resend emails:  ${emails.map((e) => `${e.to.join(",")} ${e.last_event}`).join(", ") || "none"}`);
  check("Stripe got exactly one refund, to Alice ($42.00)", refunds.length === 1 && refunds[0]!.payment_intent === "pi_alice" && refunds[0]!.amount === 4200);
  check("the email to Bob was cancelled and never sent", emails.length === 1 && emails[0]!.last_event === "canceled");
  check("every call is in the ledger", final.length >= 7);
  say();
} catch (err) {
  failed = true;
  say(c.red(`Demo failed: ${err instanceof Error ? err.message : String(err)}`));
  say(c.dim(stack.logs().slice(-3000)));
}

say(c.bold("Checks"));
for (const [label, ok] of checks) say(`  ${ok ? c.green("✓") : c.red("✗")} ${label}`);
say();

if (keep) {
  say(`Still running. Open ${c.bold(stack.url + "/undo")} and try the Undo buttons and the sentence box.`);
  say(c.dim(`Talk to the agent: pnpm exec eve remote connect --url ${stack.url}/   ·   Ctrl-C to stop.`));
  const stop = async () => {
    await stack.stop();
    process.exit(failed ? 1 : 0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  await stack.stop();
  say(failed ? c.red("Demo failed.") : c.green("Demo passed."));
  process.exit(failed ? 1 : 0);
}
