import type { MockModelRequest, MockModelResponse } from "eve/evals";

// The support agent's scripted model. Each scenario is keyed by what the
// customer said and walks a fixed list of steps; each step's tool calls carry
// ids so the script knows which results have arrived. No model provider is
// called. This stands in for a real model making the mistakes undo catches.

type Step = (results: Map<string, unknown>) => MockModelResponse | string;

const parse = (v: unknown): any => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const viaCatalog = (id: string, name: string, input: unknown) => ({ id, name: "eve__tool", input: { name, input } });

const SCENARIOS: Array<{ match: RegExp; steps: Array<{ waitFor: string[]; next: Step }> }> = [
  {
    // The demo: Alice's ticket. The agent picks the wrong order, gets redirected,
    // gets blocked, replans, and emails the wrong customer.
    match: /refund my order/i,
    steps: [
      { waitFor: [], next: () => ({ toolCalls: [viaCatalog("t1", "stripe__list_payment_intents", {})] }) },
      {
        waitFor: ["t1"],
        next: () => ({ text: "Refunding the most recent order.", toolCalls: [viaCatalog("t2", "stripe__create_refund", { payment_intent: "pi_bob" })] }),
      },
      { waitFor: ["t2"], next: () => ({ toolCalls: [{ id: "t3", name: "undo__stripe_refund", input: { payment_intent: "pi_bob" } }] }) },
      {
        waitFor: ["t3"],
        next: () => ({
          text: "The reviewer says that order is Bob's. Refunding Alice's order instead.",
          toolCalls: [
            { id: "t4", name: "undo__stripe_refund", input: { payment_intent: "pi_alice", reason: "requested_by_customer" } },
            {
              id: "t5",
              name: "undo__resend_send",
              input: { to: "bob@example.com", subject: "Your refund is on its way", text: "Hi, your refund of $42.00 is on its way." },
            },
            viaCatalog("t6", "stripe__create_coupon", { percent_off: 10, duration: "once" }),
          ],
        }),
      },
      {
        waitFor: ["t4", "t5", "t6"],
        next: (r) => {
          const refund = parse(r.get("t4"));
          return `Alice's refund of $42.00 is scheduled (${refund?.rowId}, final at ${refund?.undoUntil}). I emailed the customer and created a 10% coupon.`;
        },
      },
    ],
  },
  {
    // Done #10: the agent undoes its own mistake.
    match: /take it back/i,
    steps: [
      {
        waitFor: [],
        next: () => ({ toolCalls: [{ id: "s1", name: "undo__resend_send", input: { to: "bob@example.com", subject: "Order update", text: "Hi Bob." } }] }),
      },
      {
        waitFor: ["s1"],
        next: (r) => ({
          text: "That email went to the wrong customer. Undoing it.",
          toolCalls: [{ id: "s2", name: "undo__undo", input: { rowId: parse(r.get("s1"))?.rowId } }],
        }),
      },
      { waitFor: ["s2"], next: (r) => `Undo result: ${JSON.stringify(parse(r.get("s2")))}` },
    ],
  },
  {
    // Done #9: a reversible() tool of the developer's own.
    match: /store credit/i,
    steps: [
      { waitFor: [], next: () => ({ toolCalls: [{ id: "c1", name: "issue_credit", input: { customer: "cus_alice", cents: 500 } }] }) },
      { waitFor: ["c1"], next: (r) => `Credit issued: ${JSON.stringify(parse(r.get("c1")))}` },
    ],
  },
  {
    // Done #12: a call that needs a person.
    match: /100% coupon/i,
    steps: [
      { waitFor: [], next: () => ({ toolCalls: [viaCatalog("h1", "stripe__create_coupon", { percent_off: 100, duration: "once" })] }) },
      { waitFor: ["h1"], next: (r) => `Coupon result: ${JSON.stringify(parse(r.get("h1")))}` },
    ],
  },
];

export function respond(req: MockModelRequest): MockModelResponse | string {
  // eve adds its own text to the first user message, so match against all of them.
  const said = req.userMessages.join("\n");
  const scenario = SCENARIOS.find((s) => s.match.test(said));
  if (!scenario) return "I'm a scripted demo agent. Try: \"Hi, this is Alice. Please refund my order pi_alice.\"";
  const results = new Map<string, unknown>();
  for (const r of req.toolResults) results.set(r.id.split("#")[0]!, r.isError ? { error: r.output } : r.output);
  // The furthest step whose inputs have all arrived and whose own calls haven't been made.
  for (let i = scenario.steps.length - 1; i >= 0; i--) {
    const step = scenario.steps[i]!;
    if (step.waitFor.every((id) => results.has(id))) {
      const next = scenario.steps[i + 1];
      const made = next ? next.waitFor.some((id) => results.has(id)) : false;
      if (!made) return step.next(results);
    }
  }
  return "Done.";
}
