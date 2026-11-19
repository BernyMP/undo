import type { ReviewFn } from "undo-eve/agent";

// A scripted reviewer for the demo: it proves the wiring, not the judgement.
// It blocks a refund whose payment intent belongs to someone the conversation
// never mentions, and passes everything else, including emails. A real reviewer
// is a model call (undo's default uses `decide` through AI Gateway).
const OWNER: Record<string, string> = { pi_alice: "alice", pi_bob: "bob", pi_carol: "carol" };

export const scriptedReview: ReviewFn = (call, context) => {
  const pi = (call.input as { payment_intent?: string } | undefined)?.payment_intent;
  const owner = pi ? OWNER[pi] : undefined;
  const said = context.messages.join("\n").toLowerCase();
  if (owner && !said.includes(owner)) {
    const name = owner[0]!.toUpperCase() + owner.slice(1);
    return { verdict: "block", reason: `customer doesn't match the ticket (${pi} is ${name}'s order)` };
  }
  return { verdict: "approve", reason: "matches the ticket" };
};
