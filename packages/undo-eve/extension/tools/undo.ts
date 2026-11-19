import { defineTool } from "eve/tools";
import { z } from "zod";
import { getStore, planUndo, undoRow } from "../lib/index.ts";

export default defineTool({
  description:
    "Undo one of your own actions from this session. Pass `rowId` (from undo__history or a tool result), or `request` in plain words such as 'the email to Bob'. Held actions are cancelled; done actions with an inverse are reversed; others come back as irreversible with a follow-up.",
  inputSchema: z.object({
    rowId: z.string().optional(),
    request: z.string().optional(),
  }),
  async execute({ rowId, request }, ctx) {
    const store = await getStore();
    if (rowId) {
      const row = store.get(rowId);
      if (!row) return { status: "not_found", rowId };
      if (row.sessionId !== ctx.session.id) {
        return { status: "not_allowed", rowId, reason: "that row belongs to another session; a person can undo it from the ledger page" };
      }
      return undoRow(rowId, `agent:${ctx.session.id}`);
    }
    if (request) {
      const plan = await planUndo(request, { sessionId: ctx.session.id });
      if ("question" in plan) {
        if (plan.candidates.length === 0) return { status: "not_found" };
        return { status: "ambiguous", question: plan.question, candidates: plan.candidates.map((c) => ({ rowId: c.rowId, summary: c.summary, state: c.state })) };
      }
      const results = [];
      for (const r of plan.rows) results.push(await undoRow(r.rowId, `agent:${ctx.session.id}`));
      return results.length === 1 ? results[0] : { status: "done", results };
    }
    return { status: "not_found" };
  },
});
