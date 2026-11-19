import { defineTool } from "eve/tools";
import { z } from "zod";
import { stripeCapture } from "../lib/index.ts";

export default defineTool({
  description:
    "Capture an authorized Stripe payment now. It can be undone later with undo__undo, which refunds exactly what was captured. Returns { status: 'done', rowId, undo: 'refund' }.",
  inputSchema: z.object({
    payment_intent: z.string(),
    amount: z.number().int().positive().optional().describe("Cents. Omit to capture the full authorization."),
  }),
  async execute(input, ctx) {
    return stripeCapture(ctx, input);
  },
});
