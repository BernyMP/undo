import { defineTool } from "eve/tools";
import { z } from "zod";
import { resendSend } from "../lib/index.ts";

export default defineTool({
  description:
    "Send an email through Resend. It is scheduled for the end of the undo window (see undoUntil in the result) and can be cancelled with undo__undo until then; after that it is sent and final. Returns { status: 'scheduled', rowId, undoUntil }.",
  inputSchema: z.object({
    to: z.string().describe("One email address."),
    subject: z.string(),
    text: z.string(),
  }),
  async execute(input, ctx) {
    return resendSend(ctx, input);
  },
});
