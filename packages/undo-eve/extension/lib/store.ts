// The ledger: one row per call, plus the session's user messages (context for
// the reviewer) and sentence-undo plans. SQLite through node:sqlite.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type RowState =
  | "requested"
  | "blocked"
  | "awaiting_person"
  | "held"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "undone"
  | "conflict"
  | "irreversible";

export type Strategy = "cancel" | "reverse" | "none";
export type RowKind = "read" | "write" | "adapter" | "reversible" | "undo" | "sandbox" | "subagent" | "inverse";

export type Row = {
  id: number;
  rowId: string;
  sessionId: string;
  callId: string;
  tool: string;
  input: unknown;
  summary: string;
  kind: RowKind;
  strategy: Strategy;
  approve: string;
  state: RowState;
  reviewVerdict: string | null;
  reviewReason: string | null;
  output: unknown;
  error: string | null;
  undoUntil: number | null;
  action: any;
  ref: any;
  undoes: string | null;
  current: unknown;
  followUp: string | null;
  createdAt: number;
  updatedAt: number;
};

export type NewRow = Pick<Row, "sessionId" | "callId" | "tool" | "input" | "summary" | "kind" | "strategy" | "approve" | "state"> &
  Partial<Pick<Row, "reviewVerdict" | "reviewReason" | "undoes" | "output" | "error">>;

export type Plan = { planId: string; sentence: string; rowIds: string[]; createdAt: number; confirmedAt: number | null };

export interface LedgerStore {
  upsertRow(row: NewRow): Row;
  getByCall(sessionId: string, callId: string): Row | undefined;
  get(rowId: string): Row | undefined;
  list(opts?: { sessionId?: string; limit?: number }): Row[];
  update(rowId: string, patch: Partial<Omit<Row, "id" | "rowId">>): Row | undefined;
  /** Compare-and-set the state. Returns the updated row, or undefined if the state wasn't `from`. */
  transition(rowId: string, from: RowState | RowState[], to: RowState, patch?: Partial<Omit<Row, "id" | "rowId" | "state">>): Row | undefined;
  dueHolds(now: number): Row[];
  /** `running` rows not touched since `before` (their worker probably died). */
  staleRunning(before: number): Row[];
  /** Take over a stale `running` row: true for exactly one caller. */
  claimStale(rowId: string, before: number): boolean;
  pendingHolds(): Row[];
  addMessage(sessionId: string, text: string): void;
  messages(sessionId: string): string[];
  bumpReviewFailure(sessionId: string, key: string): number;
  savePlan(plan: Plan): void;
  getPlan(planId: string): Plan | undefined;
  confirmPlan(planId: string): Plan | undefined;
}

const JSON_COLS = ["input", "output", "action", "ref", "current"] as const;
const COLS: Record<string, string> = {
  sessionId: "session_id",
  callId: "call_id",
  tool: "tool",
  input: "input",
  summary: "summary",
  kind: "kind",
  strategy: "strategy",
  approve: "approve",
  state: "state",
  reviewVerdict: "review_verdict",
  reviewReason: "review_reason",
  output: "output",
  error: "error",
  undoUntil: "undo_until",
  action: "action",
  ref: "ref",
  undoes: "undoes",
  current: "current",
  followUp: "follow_up",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export async function openSqliteStore(path: string): Promise<LedgerStore> {
  const { DatabaseSync } = await import("node:sqlite");
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, call_id TEXT NOT NULL, tool TEXT NOT NULL,
      input TEXT, summary TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, strategy TEXT NOT NULL,
      approve TEXT NOT NULL, state TEXT NOT NULL, review_verdict TEXT, review_reason TEXT,
      output TEXT, error TEXT, undo_until INTEGER, action TEXT, ref TEXT, undoes TEXT,
      current TEXT, follow_up TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (session_id, call_id)
    );
    CREATE INDEX IF NOT EXISTS rows_state ON rows (state, undo_until);
    CREATE TABLE IF NOT EXISTS messages (session_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_failures (session_id TEXT NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (session_id, key));
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, sentence TEXT NOT NULL, row_ids TEXT NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER);
  `);

  const toRow = (r: any): Row | undefined => {
    if (!r) return undefined;
    const row: any = { id: r.id, rowId: `r${r.id}` };
    for (const [k, col] of Object.entries(COLS)) {
      const v = r[col];
      row[k] = (JSON_COLS as readonly string[]).includes(k) && typeof v === "string" ? JSON.parse(v) : (v ?? null);
    }
    return row as Row;
  };
  const enc = (k: string, v: unknown) => ((JSON_COLS as readonly string[]).includes(k) ? (v === undefined ? null : JSON.stringify(v)) : (v ?? null));
  const idOf = (rowId: string) => Number(String(rowId).replace(/^r/, ""));

  const store: LedgerStore = {
    upsertRow(row) {
      const now = Date.now();
      const existing = store.getByCall(row.sessionId, row.callId);
      if (existing) return existing;
      const data: Record<string, unknown> = { ...row, createdAt: now, updatedAt: now };
      const keys = Object.keys(data).filter((k) => COLS[k]);
      db.prepare(
        `INSERT OR IGNORE INTO rows (${keys.map((k) => COLS[k]).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      ).run(...(keys.map((k) => enc(k, data[k])) as any[]));
      return store.getByCall(row.sessionId, row.callId)!;
    },
    getByCall(sessionId, callId) {
      return toRow(db.prepare("SELECT * FROM rows WHERE session_id = ? AND call_id = ?").get(sessionId, callId));
    },
    get(rowId) {
      return toRow(db.prepare("SELECT * FROM rows WHERE id = ?").get(idOf(rowId)));
    },
    list(opts = {}) {
      const limit = opts.limit ?? 500;
      const rows = opts.sessionId
        ? db.prepare("SELECT * FROM rows WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(opts.sessionId, limit)
        : db.prepare("SELECT * FROM rows ORDER BY id DESC LIMIT ?").all(limit);
      return rows.map((r) => toRow(r)!);
    },
    update(rowId, patch) {
      const keys = Object.keys(patch).filter((k) => COLS[k]);
      if (keys.length === 0) return store.get(rowId);
      db.prepare(`UPDATE rows SET ${keys.map((k) => `${COLS[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...(keys.map((k) => enc(k, (patch as any)[k])) as any[]),
        Date.now(),
        idOf(rowId),
      );
      return store.get(rowId);
    },
    transition(rowId, from, to, patch = {}) {
      const froms = Array.isArray(from) ? from : [from];
      const keys = Object.keys(patch).filter((k) => COLS[k]);
      const result = db
        .prepare(
          `UPDATE rows SET state = ?, ${keys.map((k) => `${COLS[k]} = ?, `).join("")}updated_at = ? WHERE id = ? AND state IN (${froms.map(() => "?").join(", ")})`,
        )
        .run(to, ...(keys.map((k) => enc(k, (patch as any)[k])) as any[]), Date.now(), idOf(rowId), ...froms);
      return Number(result.changes) === 1 ? store.get(rowId) : undefined;
    },
    dueHolds(now) {
      return db.prepare("SELECT * FROM rows WHERE state = 'held' AND undo_until <= ? ORDER BY undo_until").all(now).map((r) => toRow(r)!);
    },
    staleRunning(before) {
      return db.prepare("SELECT * FROM rows WHERE state = 'running' AND updated_at <= ? ORDER BY id").all(before).map((r) => toRow(r)!);
    },
    claimStale(rowId, before) {
      const result = db.prepare("UPDATE rows SET updated_at = ? WHERE id = ? AND state = 'running' AND updated_at <= ?").run(Date.now(), idOf(rowId), before);
      return Number(result.changes) === 1;
    },
    pendingHolds() {
      return db.prepare("SELECT * FROM rows WHERE state = 'held' ORDER BY undo_until").all().map((r) => toRow(r)!);
    },
    addMessage(sessionId, text) {
      db.prepare("INSERT INTO messages (session_id, text, at) VALUES (?, ?, ?)").run(sessionId, text, Date.now());
    },
    messages(sessionId) {
      return db.prepare("SELECT text FROM messages WHERE session_id = ? ORDER BY at").all(sessionId).map((r: any) => r.text);
    },
    bumpReviewFailure(sessionId, key) {
      db.prepare(
        "INSERT INTO review_failures (session_id, key, count) VALUES (?, ?, 1) ON CONFLICT (session_id, key) DO UPDATE SET count = count + 1",
      ).run(sessionId, key);
      return Number((db.prepare("SELECT count FROM review_failures WHERE session_id = ? AND key = ?").get(sessionId, key) as any).count);
    },
    savePlan(plan) {
      db.prepare("INSERT INTO plans (id, sentence, row_ids, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?)").run(
        plan.planId,
        plan.sentence,
        JSON.stringify(plan.rowIds),
        plan.createdAt,
        plan.confirmedAt,
      );
    },
    getPlan(planId) {
      const r: any = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
      return r ? { planId: r.id, sentence: r.sentence, rowIds: JSON.parse(r.row_ids), createdAt: r.created_at, confirmedAt: r.confirmed_at } : undefined;
    },
    confirmPlan(planId) {
      const result = db.prepare("UPDATE plans SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL").run(Date.now(), planId);
      return Number(result.changes) === 1 ? store.getPlan(planId) : undefined;
    },
  };
  return store;
}
