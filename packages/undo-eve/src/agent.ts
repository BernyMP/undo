// What an agent imports: undo() for agent/extensions/undo.ts, undoPolicy() for
// agent/agent.ts, and reversible() for the agent's own tools.

import { defineTool } from "eve/tools";
import type { z } from "zod";
// @ts-ignore: dist/ is written by `eve extension build`, which also type-checks this file.
import extension from "../dist/index.mjs";
import {
  decide,
  getConfig,
  getStore,
  idemKey,
  makeCtx,
  registerReversible,
  requireConfig,
  rowForCall,
  setConfig,
  stricter,
  statusRank,
  isRecheck,
  summarize,
  type PolicyCall,
  type ReversibleCtx,
  type UndoConfig,
} from "../extension/lib/index.ts";

export type { UndoConfig, ReviewFn, MatchFn, ReviewCall, ReviewContext, RowSummary } from "../extension/lib/config.ts";
export type { ReversibleCtx } from "../extension/lib/registry.ts";
export { keywordMatch } from "../extension/lib/plan.ts";

/** Mount undo. Use in agent/extensions/undo.ts: `export default undo({ ... })`. */
export function undo(config: UndoConfig = {}) {
  setConfig(config);
  return (extension as any)(config);
}

/**
 * The agent-wide approval policy. Put it in agent/agent.ts:
 * `approval: undoPolicy()` or `approval: undoPolicy(yourPolicy)`.
 */
export function undoPolicy(inner?: (ctx: any) => unknown) {
  return async (ctx: any) => {
    const theirs = inner ? await inner(ctx) : undefined;
    const ours = await decide(ctx as PolicyCall);
    // On eve's recheck after a person approved, their "ask a person" is already answered.
    if (isRecheck(ctx) && statusRank(theirs) === 2) return ours;
    const result = stricter(ours, theirs);
    if (result !== ours && getConfig()) {
      // Their policy was stricter: keep the row honest.
      const store = await getStore();
      const row = store.getByCall(ctx.session.id, ctx.callId);
      if (row && statusRank(result) === 3) {
        store.transition(row.rowId, ["requested", "awaiting_person"], "blocked", { reviewReason: result?.reason ?? "denied by your policy" });
      } else if (row && statusRank(result) === 2) {
        store.transition(row.rowId, "requested", "awaiting_person");
      }
    }
    return result;
  };
}

type ToolCtx = { session: { id: string }; callId: string; toolName: string; abortSignal?: AbortSignal; [k: string]: unknown };

type ReversibleOptions<S extends z.ZodType, O> = {
  /** The tool's final name, which must match its file path (agent/tools/<name>.ts). */
  name: string;
  description: string;
  inputSchema: S;
  approve?: "none" | "agent" | "human";
  /** Gets eve's tool context plus `idempotencyKey`. */
  do(input: z.infer<S>, ctx: ToolCtx & { idempotencyKey: string; rowId: string }): Promise<O> | O;
  undo(input: z.infer<S>, result: O, ctx: ReversibleCtx): Promise<unknown> | unknown;
  summary?(input: z.infer<S>): string;
};

/** Wrap one of your own tools so it can be undone. */
export function reversible<S extends z.ZodType, O>(opts: ReversibleOptions<S, O>) {
  registerReversible(opts as any);
  return defineTool({
    description: `${opts.description} It can be undone later with undo__undo.`,
    inputSchema: opts.inputSchema,
    async execute(input: any, ctx: any) {
      if (ctx.toolName !== opts.name) {
        throw new Error(`undo: reversible() is named "${opts.name}" but eve calls this tool "${ctx.toolName}". Make them match.`);
      }
      requireConfig();
      const { store, row } = await rowForCall(ctx, input, { kind: "reversible", strategy: "reverse", summary: summarize(opts.name, input) });
      const idempotencyKey = idemKey(store, row.rowId, "do");
      const result = await opts.do(input, Object.assign(Object.create(ctx), { idempotencyKey, rowId: row.rowId }));
      store.update(row.rowId, { output: result as any });
      // "failed" too: the hook may have marked an interrupted call before `do` came back.
      store.transition(row.rowId, ["requested", "failed"], "done", { error: null });
      return { ...(typeof result === "object" && result !== null ? result : { result }), rowId: row.rowId } as any;
    },
  } as any);
}
