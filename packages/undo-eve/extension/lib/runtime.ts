// Shared runtime: the ledger store and the hold executor. Holds live in the
// ledger's state machine: `held` until `undoUntil`, then a compare-and-set to
// `running`. An in-process timer runs each hold on time; `sweep()` runs anything
// the timer missed (after a restart, from every API read, and from the
// undo__sweep schedule). The compare-and-set makes each hold run once.

import { requireConfig } from "./config.ts";
import { openSqliteStore, type LedgerStore, type Row } from "./store.ts";

const KEY = Symbol.for("undo-eve.runtime");

type Shared = {
  stores: Map<string, Promise<LedgerStore>>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  booted: Set<string>;
  executors: Map<string, (row: Row) => Promise<void>>;
};

function shared(): Shared {
  const g = globalThis as any;
  return (g[KEY] ??= { stores: new Map(), timers: new Map(), booted: new Set(), executors: new Map() });
}

export function ledgerPath(): string {
  const cfg = requireConfig();
  const s = cfg.store as { path?: string } | undefined;
  return s?.path ?? process.env.UNDO_LEDGER ?? ".undo/ledger.db";
}

export async function getStore(): Promise<LedgerStore> {
  const cfg = requireConfig();
  const custom = cfg.store as LedgerStore | undefined;
  if (custom && typeof (custom as any).upsertRow === "function") return boot("custom", Promise.resolve(custom));
  const path = ledgerPath();
  const sh = shared();
  let p = sh.stores.get(path);
  if (!p) {
    p = openSqliteStore(path);
    sh.stores.set(path, p);
  }
  return boot(path, p);
}

async function boot(key: string, p: Promise<LedgerStore>): Promise<LedgerStore> {
  const store = await p;
  const sh = shared();
  if (!sh.booted.has(key)) {
    sh.booted.add(key);
    // After a restart: run what came due while we were down, and re-arm the rest.
    queueMicrotask(() => void sweep(store).then(() => store.pendingHolds().forEach((r) => armTimer(r))));
  }
  return store;
}

/** The function that performs a held action. Set by adapters.ts. */
export function setHeldExecutor(kind: string, fn: (row: Row) => Promise<void>) {
  shared().executors.set(kind, fn);
}

export function armTimer(row: Row) {
  if (row.state !== "held" || row.undoUntil == null) return;
  const sh = shared();
  const existing = sh.timers.get(row.rowId);
  if (existing) clearTimeout(existing);
  const delay = Math.max(0, row.undoUntil - Date.now());
  const t = setTimeout(() => {
    sh.timers.delete(row.rowId);
    void getStore().then((store) => runHeld(store, row.rowId));
  }, delay + 25);
  (t as any).unref?.();
  sh.timers.set(row.rowId, t);
}

/** How long a `running` row may go untouched before a sweep takes it over. */
export const leaseMs = () => Number(process.env.UNDO_LEASE_MS ?? 60_000);

/** Recovers a `running` row whose worker died, by its claim. Set by undo.ts. */
let recoverer: ((store: LedgerStore, row: Row) => Promise<void>) | undefined;
export function setRecoverer(fn: (store: LedgerStore, row: Row) => Promise<void>) {
  recoverer = fn;
  (globalThis as any)[Symbol.for("undo-eve.recover")] = fn;
}

export async function sweep(store?: LedgerStore): Promise<number> {
  const s = store ?? (await getStore());
  const due = s.dueHolds(Date.now());
  for (const row of due) await runHeld(s, row.rowId);
  const before = Date.now() - leaseMs();
  const stale = s.staleRunning(before);
  for (const row of stale) {
    if (!s.claimStale(row.rowId, before)) continue;
    const fresh = s.get(row.rowId)!;
    if (fresh.ref?.claim === "run") {
      await execute(s, fresh);
    } else {
      const fn = recoverer ?? (globalThis as any)[Symbol.for("undo-eve.recover")];
      if (fn) await fn(s, fresh);
    }
  }
  return due.length + stale.length;
}

export async function runHeld(store: LedgerStore, rowId: string): Promise<void> {
  const row = store.get(rowId);
  if (!row || row.state !== "held" || (row.undoUntil ?? 0) > Date.now()) return;
  const running = store.transition(rowId, "held", "running", { ref: { ...(row.ref ?? {}), claim: "run" } });
  if (!running) return; // someone else got there first, or it was cancelled
  await execute(store, running);
}

async function execute(store: LedgerStore, running: Row): Promise<void> {
  const rowId = running.rowId;
  const exec = shared().executors.get(running.action?.op);
  if (!exec) {
    store.transition(rowId, "running", "failed", { error: `undo: no executor for "${running.action?.op}"` });
    return;
  }
  try {
    await exec(running);
  } catch (err) {
    store.transition(rowId, "running", "failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
