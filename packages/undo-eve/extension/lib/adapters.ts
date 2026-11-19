// Adapters: undo's own tools for a Vercel Connect service, with a strategy, a
// hold and a default approve. Keyed by Connect service name; each lists the
// connection tools it replaces (`covers`) and the service's read tools (`reads`).

import type { Approve } from "./config.ts";
import { requireConfig } from "./config.ts";
import { armTimer, getStore, setHeldExecutor } from "./runtime.ts";
import { resend, ServiceError, stripe } from "./services.ts";
import type { LedgerStore, Row, Strategy } from "./store.ts";

export type AdapterDef = {
  /** Final tool name, e.g. "undo__stripe_refund". */
  tool: string;
  service: "stripe" | "resend";
  strategy: Strategy;
  defaultApprove: Approve;
  covers: string[];
  summary(input: any): string;
};

export const SERVICE_READS: Record<"stripe" | "resend", string[]> = {
  stripe: [
    "retrieve_customer",
    "list_customers",
    "search_customers",
    "retrieve_payment_intent",
    "list_payment_intents",
    "list_refunds",
    "retrieve_balance",
    "search_documentation",
  ],
  resend: ["get_email", "list_emails", "list_domains"],
};

const money = (cents: number | undefined) => (cents == null ? "the full amount" : `$${(cents / 100).toFixed(2)}`);

export const ADAPTERS: AdapterDef[] = [
  {
    tool: "undo__stripe_refund",
    service: "stripe",
    strategy: "cancel",
    defaultApprove: "agent",
    covers: ["create_refund"],
    summary: (i) => `refund ${money(i?.amount)} on ${i?.payment_intent}`,
  },
  {
    tool: "undo__stripe_capture",
    service: "stripe",
    strategy: "reverse",
    defaultApprove: "agent",
    covers: ["capture_payment_intent"],
    summary: (i) => `capture ${money(i?.amount)} on ${i?.payment_intent}`,
  },
  {
    tool: "undo__resend_send",
    service: "resend",
    strategy: "cancel",
    defaultApprove: "agent",
    covers: ["send_email"],
    summary: (i) => `email ${i?.to}: "${i?.subject}"`,
  },
];

export const adapterByTool = (tool: string) => ADAPTERS.find((a) => a.tool === tool);

export const FOLLOW_UP: Record<string, string> = {
  undo__stripe_refund: "The refund already went out. Charge the customer again or tell them what happened.",
  undo__stripe_capture: "The capture can no longer be refunded automatically. Check the payment in Stripe.",
  undo__resend_send: "The email was already sent. Send a short correction to the same address.",
};

/** Finds the row undoPolicy wrote for this call, or writes one if the policy isn't installed. */
export async function rowForCall(
  ctx: { session: { id: string }; callId: string; toolName: string },
  input: unknown,
  fallback: { kind: Row["kind"]; strategy: Strategy; summary: string },
): Promise<{ store: LedgerStore; row: Row }> {
  const store = await getStore();
  let row = store.getByCall(ctx.session.id, ctx.callId);
  if (!row) {
    console.warn("[undo] undoPolicy is not set in agent.ts: this call was not checked before it ran. Add `approval: undoPolicy()`.");
    row = store.upsertRow({
      sessionId: ctx.session.id,
      callId: ctx.callId,
      tool: ctx.toolName,
      input,
      summary: fallback.summary,
      kind: fallback.kind,
      strategy: fallback.strategy,
      approve: "none",
      state: "requested",
    });
  }
  return { store, row };
}

function hold(store: LedgerStore, row: Row, action: unknown, ref?: unknown) {
  const undoUntil = Date.now() + requireConfig().holdMs;
  const held = store.transition(row.rowId, "requested", "held", { undoUntil, action, ref });
  if (!held) throw new Error(`undo: row ${row.rowId} is ${store.get(row.rowId)?.state}, not requested`);
  armTimer(held);
  return { status: "scheduled" as const, rowId: held.rowId, undoUntil: new Date(undoUntil).toISOString() };
}

// ---- Stripe refund: held by undo, then final ----

export async function stripeRefund(ctx: any, input: { payment_intent: string; amount?: number; reason?: string }) {
  const def = adapterByTool("undo__stripe_refund")!;
  const { store, row } = await rowForCall(ctx, input, { kind: "adapter", strategy: def.strategy, summary: def.summary(input) });
  // Check now that Stripe would accept it, so most failures come back at once.
  const pi = await stripe.paymentIntent(input.payment_intent);
  if (pi.status !== "succeeded") throw new Error(`${pi.id} is ${pi.status}; only a captured payment can be refunded.`);
  const refunded = (await stripe.refunds(pi.id)).reduce((s: number, r: any) => s + r.amount, 0);
  const pendingHolds = store
    .pendingHolds()
    .filter((r) => r.action?.op === "stripe.refund" && r.action.params.payment_intent === pi.id)
    .reduce((s, r) => s + (r.action.params.amount ?? pi.amount_received), 0);
  const left = pi.amount_received - refunded - pendingHolds;
  const amount = input.amount ?? left;
  if (amount <= 0 || amount > left) throw new Error(`Only $${(left / 100).toFixed(2)} of ${pi.id} can still be refunded.`);
  return hold(store, row, { op: "stripe.refund", params: { payment_intent: pi.id, amount, reason: input.reason } });
}

setHeldExecutor("stripe.refund", async (row) => {
  const store = await getStore();
  const refund = await stripe.createRefund(row.action.params, `undo-${row.rowId}-do`);
  store.transition(row.rowId, "running", "irreversible", { output: { status: "done", refund }, ref: { refund: refund.id } });
});

// ---- Resend send: held natively with scheduled_at, cancelled through Resend ----

export async function resendSend(ctx: any, input: { to: string; subject: string; text: string }) {
  const def = adapterByTool("undo__resend_send")!;
  const { store, row } = await rowForCall(ctx, input, { kind: "adapter", strategy: def.strategy, summary: def.summary(input) });
  const cfg = requireConfig();
  const scheduledAt = new Date(Date.now() + cfg.holdMs).toISOString();
  const email = await resend.send(
    { from: cfg.services?.resend?.from ?? "shop@example.com", to: input.to, subject: input.subject, text: input.text, scheduled_at: scheduledAt },
    `undo-${row.rowId}-do`,
  );
  return hold(store, row, { op: "resend.scheduled", params: { id: email.id } }, { email: email.id });
}

setHeldExecutor("resend.scheduled", async (row) => {
  const store = await getStore();
  const email = await resend.get(row.action.params.id);
  if (email.last_event === "canceled") store.transition(row.rowId, "running", "cancelled");
  else if (email.last_event === "scheduled") store.transition(row.rowId, "running", "held", { undoUntil: Date.now() + 1000 });
  else store.transition(row.rowId, "running", "irreversible", { output: { status: "done", email: email.id, last_event: email.last_event } });
});

// ---- Stripe capture: runs now; the inverse is a refund ----

export async function stripeCapture(ctx: any, input: { payment_intent: string; amount?: number }) {
  const def = adapterByTool("undo__stripe_capture")!;
  const { store, row } = await rowForCall(ctx, input, { kind: "adapter", strategy: def.strategy, summary: def.summary(input) });
  const pi = await stripe.capture(input.payment_intent, { amount_to_capture: input.amount }, `undo-${row.rowId}-do`);
  store.transition(row.rowId, "requested", "done", { output: { status: "done", payment_intent: pi.id, amount: pi.amount_received } });
  return { status: "done" as const, rowId: row.rowId, undo: "refund" as const };
}

// ---- Inverses and cancels, used by undoRow ----

export type UndoOutcome =
  | { status: "cancelled" | "undone"; rowId: string }
  | { status: "conflict"; rowId: string; current: unknown }
  | { status: "irreversible"; rowId: string; followUp: string };

/** Cancel a held adapter row. Caller has already moved it held -> running. */
export async function cancelHeld(row: Row): Promise<"cancelled" | "too_late"> {
  if (row.action?.op === "stripe.refund") return "cancelled"; // nothing reached Stripe yet
  if (row.action?.op === "resend.scheduled") {
    try {
      await resend.cancel(row.action.params.id);
      return "cancelled";
    } catch (err) {
      if (err instanceof ServiceError && err.status === 422) {
        const email = await resend.get(row.action.params.id);
        return email.last_event === "canceled" ? "cancelled" : "too_late";
      }
      throw err;
    }
  }
  return "cancelled";
}

/**
 * Reverse a done adapter row (compare-and-restore). `retry` is true when an
 * earlier undo of this row started but didn't finish; then a refund already on
 * the payment may be ours, and the same idempotency key makes Stripe replay it.
 */
export async function reverseAdapter(row: Row, retry: boolean): Promise<{ ok: true; output: unknown } | { conflict: unknown }> {
  if (row.tool === "undo__stripe_capture") {
    const piId = (row.input as any)?.payment_intent;
    const captured = (row.output as any)?.amount;
    const refunded = (await stripe.refunds(piId)).reduce((s: number, r: any) => s + r.amount, 0);
    if (refunded > 0 && !retry) {
      // Someone refunded this payment after the agent captured it: never refund twice.
      return { conflict: { payment_intent: piId, amount_refunded: refunded, captured } };
    }
    const refund = await stripe.createRefund({ payment_intent: piId, amount: captured }, `undo-${row.rowId}-undo`);
    return { ok: true, output: { refund } };
  }
  throw new Error(`undo: ${row.tool} has no inverse`);
}
