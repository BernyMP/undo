// Undo one row, whatever its strategy. Used by the Undo button, undo__undo and
// the sentence box. Safe to call twice: the state machine lets one caller in,
// and inverses carry an idempotency key derived from the row.

import { FOLLOW_UP, cancelHeld, reverseAdapter } from "./adapters.ts";
import { getReversible, isConflict, makeCtx } from "./registry.ts";
import { getStore, setRecoverer, withLease } from "./runtime.ts";
import { idemKey } from "./store.ts";
import type { LedgerStore, Row } from "./store.ts";

export type UndoResult =
  | { status: "cancelled" | "undone"; rowId: string }
  | { status: "conflict"; rowId: string; current: unknown }
  | { status: "irreversible"; rowId: string; followUp: string }
  | { status: "not_found"; rowId?: string }
  | { status: "not_allowed"; rowId: string; reason: string }
  | { status: "failed"; rowId: string; error: string };

const GENERIC_FOLLOW_UP = "This can't be undone automatically. Tell the person who asked, and fix it by hand if needed.";

function recordInverse(store: LedgerStore, row: Row, actor: string, summary: string, output?: unknown) {
  store.upsertRow({
    sessionId: row.sessionId,
    callId: `undo:${row.rowId}`,
    tool: `undo of ${row.tool}`,
    input: { rowId: row.rowId, by: actor },
    summary,
    kind: "inverse",
    strategy: "none",
    approve: "none",
    state: "done",
    undoes: row.rowId,
    output,
  });
}

export async function undoRow(rowId: string, actor = "ledger"): Promise<UndoResult> {
  const store = await getStore();
  const row = store.get(rowId);
  if (!row) return { status: "not_found", rowId };

  switch (row.state) {
    case "cancelled":
      return { status: "cancelled", rowId };
    case "undone":
      return { status: "undone", rowId };
    case "conflict":
      return { status: "conflict", rowId, current: row.current };
    case "blocked":
    case "requested":
    case "awaiting_person":
      return { status: "not_allowed", rowId, reason: "this call never ran, so there is nothing to undo" };
    case "running":
      return { status: "not_allowed", rowId, reason: "it is running right now; check again in a moment" };
    case "failed":
      return {
        status: "not_allowed",
        rowId,
        reason: row.error?.startsWith("interrupted")
          ? "it was interrupted and may have partly run; check the service by hand"
          : `it failed before it changed anything: ${row.error ?? "unknown error"}`,
      };
    case "irreversible":
      return { status: "irreversible", rowId, followUp: FOLLOW_UP[row.tool] ?? GENERIC_FOLLOW_UP };
  }

  if (row.state === "held") {
    const claimed = store.transition(rowId, "held", "running", { ref: { ...(row.ref ?? {}), claim: "cancel" } });
    if (!claimed) return undoRow(rowId, actor); // the hold just ended or someone else undid it
    return finishCancel(store, claimed, actor);
  }

  // state "done"
  if (row.strategy !== "reverse") {
    return { status: "irreversible", rowId, followUp: FOLLOW_UP[row.tool] ?? GENERIC_FOLLOW_UP };
  }
  const retry = Boolean(row.ref?.undoStarted);
  const claimed = store.transition(rowId, "done", "running", { ref: { ...(row.ref ?? {}), undoStarted: true, claim: "undo" } });
  if (!claimed) return undoRow(rowId, actor);
  return finishReverse(store, claimed, actor, retry);
}

async function finishCancel(store: LedgerStore, row: Row, actor: string): Promise<UndoResult> {
  const rowId = row.rowId;
  const result = await withLease(store, rowId, () => cancelHeld(row));
  if (result === "too_late") {
    if (!store.transition(rowId, "running", "irreversible")) return settled(store, rowId);
    return { status: "irreversible", rowId, followUp: FOLLOW_UP[row.tool] ?? GENERIC_FOLLOW_UP };
  }
  if (!store.transition(rowId, "running", "cancelled")) return settled(store, rowId);
  recordInverse(store, row, actor, `cancelled ${row.summary}`);
  return { status: "cancelled", rowId };
}

/** Another worker moved the row first: report what the row says now. */
async function settled(store: LedgerStore, rowId: string): Promise<UndoResult> {
  const now = store.get(rowId);
  if (!now) return { status: "not_found", rowId };
  if (now.state === "running") return { status: "not_allowed", rowId, reason: "it is running right now; check again in a moment" };
  return undoRow(rowId);
}

async function finishReverse(store: LedgerStore, row: Row, actor: string, retry: boolean): Promise<UndoResult> {
  const rowId = row.rowId;
  try {
    const outcome = await withLease(store, rowId, async (): Promise<{ ok: true; output: unknown } | { conflict: unknown }> => {
      if (row.kind === "reversible") {
        const def = getReversible(row.tool);
        if (!def) throw new Error(`no reversible() tool named "${row.tool}" is loaded`);
        const value = await def.undo(row.input as any, row.output as any, makeCtx(row.rowId, idemKey(store, row.rowId, "undo"), retry));
        return isConflict(value) ? { conflict: value.current } : { ok: true, output: value ?? null };
      }
      return reverseAdapter(store, row, retry);
    });
    if ("conflict" in outcome) {
      if (!store.transition(rowId, "running", "conflict", { current: outcome.conflict })) return settled(store, rowId);
      return { status: "conflict", rowId, current: outcome.conflict };
    }
    if (!store.transition(rowId, "running", "undone")) return settled(store, rowId);
    recordInverse(store, row, actor, `reversed ${row.summary}`, outcome.output);
    return { status: "undone", rowId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Back to done so it can be tried again; `undoStarted` stays set, so the next try is a retry.
    if (!store.transition(rowId, "running", "done", { error })) return settled(store, rowId);
    return { status: "failed", rowId, error };
  }
}

// A sweep found this row `running` past its lease: finish what the dead worker started.
setRecoverer(async (store, row) => {
  if (row.ref?.claim === "cancel") await finishCancel(store, row, "recovery");
  else if (row.ref?.claim === "undo") await finishReverse(store, row, "recovery", true);
});

export function canUndo(row: Row): boolean {
  return row.state === "held" || (row.state === "done" && row.strategy === "reverse");
}
