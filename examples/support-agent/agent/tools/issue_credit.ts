import { reversible } from "undo-eve/agent";
import { z } from "zod";
import { FAKES_URL } from "../lib/env.ts";

const base = `${FAKES_URL}/stripe/v1/customers`;
const headers = { authorization: "Bearer sk_test_fake", "content-type": "application/x-www-form-urlencoded" };

// Your own tool, made undoable: store credit through Stripe customer balance
// transactions. `undo` refuses to overwrite a newer change (conflict).
export default reversible({
  name: "issue_credit",
  description: "Give a customer store credit, in cents.",
  approve: "agent",
  inputSchema: z.object({ customer: z.string(), cents: z.number().int().positive() }),
  summary: ({ customer, cents }) => `credit $${(cents / 100).toFixed(2)} to ${customer}`,
  do: async ({ customer, cents }, ctx) => {
    const res = await fetch(`${base}/${customer}/balance_transactions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": ctx.idempotencyKey },
      body: new URLSearchParams({ amount: String(-cents), description: "store credit" }),
    });
    if (!res.ok) throw new Error(`Stripe said ${res.status}`);
    const tx = await res.json();
    return { changeId: tx.id as string, balance: tx.ending_balance as number };
  },
  undo: async ({ customer, cents }, result, ctx) => {
    const list = await (await fetch(`${base}/${customer}/balance_transactions`, { headers })).json();
    const latest = list.data[0];
    // On a retry, the newest change may be our own reversal: the same key makes Stripe replay it.
    if (!ctx.retry && latest?.id !== result.changeId) return ctx.conflict({ latest });
    const res = await fetch(`${base}/${customer}/balance_transactions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": ctx.idempotencyKey },
      body: new URLSearchParams({ amount: String(cents), description: "undo store credit" }),
    });
    if (!res.ok) throw new Error(`Stripe said ${res.status}`);
  },
});
