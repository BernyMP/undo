import { defineTool } from "eve/tools";
import { z } from "zod";
import { stripeRefund } from "../lib/index.ts";

export default defineTool({
  description:
    "Refund a Stripe payment (all of it, or `amount` in cents). Use this instead of a direct create_refund. The refund is held for the undo window (see undoUntil in the result), then sent to Stripe and final; undo__undo during the hold cancels it. Returns { status: 'scheduled', rowId, undoUntil }.",
  inputSchema: z.object({
    payment_intent: z.string().describe("The payment intent id, e.g. pi_123."),
    amount: z.number().int().positive().optional().describe("Cents. Omit to refund what is left."),
    reason: z.string().optional(),
  }),
  async execute(input, ctx) {
    return stripeRefund(ctx, input);
  },
});
