import { defineTool } from "eve/tools";
import { z } from "zod";
import { historyLines } from "../lib/index.ts";

export default defineTool({
  description:
    "List what you did in this session, one line per action: row id, tool, summary, state (scheduled actions show 'held' and when the undo window ends). Failed actions come first. Use it before telling anyone an action happened, and to find a row id for undo__undo.",
  inputSchema: z.object({
    query: z.string().optional().describe("Only rows whose tool, summary or input contain this text."),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async execute({ query, limit }, ctx) {
    return historyLines({ sessionId: ctx.session.id, query, limit });
  },
});
