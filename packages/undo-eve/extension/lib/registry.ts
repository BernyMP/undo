// Process-wide registry of reversible() tools, keyed by final tool name. It lives
// on globalThis because the agent's tool modules and the extension's bundle are
// separate module graphs in one process.

export type Conflict = { __undoConflict: true; current: unknown };

export type ReversibleCtx = {
  /** Derived from the ledger row: the same on every retry of this `do` or `undo`. */
  idempotencyKey: string;
  rowId: string;
  /** Return this from `undo` when someone else changed the thing since. */
  conflict(current: unknown): Conflict;
};

export type ReversibleDef<I = any, O = any> = {
  name: string;
  description: string;
  approve?: "none" | "agent" | "human";
  do(input: I, ctx: ReversibleCtx): Promise<O> | O;
  undo(input: I, result: O, ctx: ReversibleCtx): Promise<unknown> | unknown;
  summary?(input: I): string;
};

const KEY = Symbol.for("undo-eve.reversible");

function map(): Map<string, ReversibleDef> {
  const g = globalThis as any;
  return (g[KEY] ??= new Map());
}

export function registerReversible(def: ReversibleDef) {
  const existing = map().get(def.name);
  if (existing && existing !== def && existing.description !== def.description) {
    console.error(`[undo] two reversible() tools are named "${def.name}"; the last one loaded wins. Give each a unique name.`);
  }
  map().set(def.name, def);
}

export function getReversible(name: string): ReversibleDef | undefined {
  return map().get(name);
}

export function isConflict(value: unknown): value is Conflict {
  return typeof value === "object" && value !== null && (value as any).__undoConflict === true;
}

export function makeCtx(rowId: string, phase: "do" | "undo"): ReversibleCtx {
  return {
    idempotencyKey: `undo-${rowId}-${phase}`,
    rowId,
    conflict: (current) => ({ __undoConflict: true, current }),
  };
}
