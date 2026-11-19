// Everything the extension files and src/agent.ts share. Importing this module
// registers the adapters' hold executors.

export * from "./config.ts";
export * from "./store.ts";
export * from "./registry.ts";
export * from "./runtime.ts";
export * from "./adapters.ts";
export * from "./classify.ts";
export * from "./policy.ts";
export * from "./undo.ts";
export * from "./plan.ts";

import { requireConfig } from "./config.ts";
import { toSummary } from "./policy.ts";
import { getStore, sweep } from "./runtime.ts";
import { canUndo } from "./undo.ts";

/** One line per row for undo__history; failed rows first. */
export async function historyLines(opts: { sessionId?: string; query?: string; limit?: number }) {
  const store = await getStore();
  await sweep(store);
  let rows = store.list({ sessionId: opts.sessionId, limit: 500 }).filter((r) => r.kind !== "undo" && r.kind !== "read");
  if (opts.query) {
    const q = opts.query.toLowerCase();
    rows = rows.filter((r) => `${r.tool} ${r.summary} ${JSON.stringify(r.input)}`.toLowerCase().includes(q));
  }
  rows.sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed") || b.id - a.id);
  rows = rows.slice(0, opts.limit ?? 20);
  if (rows.length === 0) return "No matching actions.";
  return rows
    .map((r) => {
      const until = r.state === "held" && r.undoUntil ? ` [undo until ${new Date(r.undoUntil).toISOString()}]` : "";
      const why = r.state === "blocked" && r.reviewReason ? ` (${r.reviewReason})` : r.state === "failed" && r.error ? ` (${r.error})` : "";
      return `${r.rowId} ${r.tool} ${r.summary} ${r.state}${why}${until}`;
    })
    .join("\n");
}

/** Rows for the ledger page and API: failed first, then newest first. */
export async function apiRows() {
  const store = await getStore();
  await sweep(store);
  const rows = store.list({ limit: 500 });
  rows.sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed") || b.id - a.id);
  return rows.map((r) => ({
    ...toSummary(r),
    kind: r.kind,
    approve: r.approve,
    reviewVerdict: r.reviewVerdict,
    reviewReason: r.reviewReason,
    undoUntil: r.undoUntil,
    undoes: r.undoes,
    error: r.error,
    output: r.output,
    current: r.current,
    canUndo: canUndo(r),
  }));
}

export function pageEnabled() {
  return requireConfig().page && process.env.EVE_DEV === "1";
}
