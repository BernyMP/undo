// undo's configuration. `undo()` in agent/extensions/undo.ts stores it on
// globalThis, because eve bundles the extension and the agent's own files
// separately: `undoPolicy()` in agent.ts and the extension's tools, hooks and
// routes each get their own copy of this module, but share one process.

import type { LedgerStore } from "./store.ts";

export type Approve = "none" | "agent" | "human";
export type ApproveRule = Approve | ((call: { toolName: string; input: unknown }) => Approve);

export type ServiceConfig = {
  /** API base, e.g. "https://api.stripe.com" or the local fake "http://127.0.0.1:4500/stripe". */
  baseUrl?: string;
  /** A bearer token, or a function that returns one (e.g. Vercel Connect's getToken). */
  token?: string | (() => Promise<string> | string);
};

export type RowSummary = {
  rowId: string;
  sessionId: string;
  tool: string;
  summary: string;
  state: string;
  strategy: string;
  createdAt: number;
  input: unknown;
};

export type ReviewCall = { toolName: string; input: unknown; summary: string };
export type ReviewContext = { sessionId: string; messages: string[]; rows: RowSummary[]; signal?: AbortSignal };
export type ReviewVerdict = { verdict: "approve" | "block"; reason: string };
export type ReviewFn = (call: ReviewCall, context: ReviewContext) => Promise<ReviewVerdict> | ReviewVerdict;

export type MatchResult = { rowIds: string[]; question?: string };
export type MatchFn = (sentence: string, rows: RowSummary[]) => Promise<MatchResult> | MatchResult;

export type UndoConfig = {
  /** How long cancel-strategy actions wait before they run. "2m", "20s" or milliseconds. */
  hold?: string | number;
  /** Approval for writes with no per-tool setting. */
  defaultApprove?: Approve;
  /** Per-tool approval by final tool name. Wins over a tool's own `approve`. */
  approve?: Record<string, ApproveRule>;
  /** Extra tool names to treat as reads. */
  reads?: string[];
  /** Names of declared subagents; calls to them are recorded with approve "none". */
  subagents?: string[];
  /** Which connection each adapter service uses, e.g. { stripe: "stripe" }. */
  adapters?: { stripe?: string; resend?: string };
  /** How adapters reach each service. Default: the real API with a Vercel Connect token. */
  services?: { stripe?: ServiceConfig; resend?: ServiceConfig & { from?: string } };
  /** The reviewer. Default: `decide` from eve/ai through AI Gateway. */
  review?: ReviewFn;
  /** Turns a sentence into ledger rows. Default: `decide`-based. */
  match?: MatchFn;
  /** Where the ledger lives. Default: SQLite at .undo/ledger.db. */
  store?: { path?: string } | LedgerStore;
  /** Serve the /undo page and API. Default: on only under `eve dev` (they are unauthenticated). */
  page?: boolean;
};

export type ResolvedConfig = Required<Pick<UndoConfig, "defaultApprove" | "approve" | "reads" | "subagents" | "adapters">> &
  UndoConfig & { holdMs: number; page: boolean };

const KEY = Symbol.for("undo-eve.config");

export function parseDuration(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`undo: can't read the duration "${value}". Use "20s", "2m" or milliseconds.`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

export function setConfig(config: UndoConfig): ResolvedConfig {
  // A subagent mounting undo() with no options reuses the root agent's config.
  const existing = getConfig();
  if (existing && Object.keys(config).length === 0) return existing;
  for (const tool of Object.keys(config.approve ?? {})) {
    if (/^[a-z0-9_-]+__(create_refund|capture_payment_intent|send_email)$/.test(tool)) {
      console.warn(`[undo] approve.${tool} is ignored: undo redirects that call to its adapter. Key it by the adapter's name, e.g. undo__stripe_refund.`);
    }
  }
  const resolved: ResolvedConfig = {
    ...config,
    holdMs: parseDuration(config.hold, 120_000),
    defaultApprove: config.defaultApprove ?? "agent",
    approve: config.approve ?? {},
    reads: config.reads ?? [],
    subagents: config.subagents ?? [],
    adapters: config.adapters ?? {},
    page: config.page ?? process.env.EVE_DEV === "1",
  };
  (globalThis as any)[KEY] = resolved;
  return resolved;
}

export function getConfig(): ResolvedConfig | undefined {
  return (globalThis as any)[KEY];
}

export function requireConfig(): ResolvedConfig {
  const c = getConfig();
  if (!c) {
    throw new Error(
      'undo: no config. Mount undo with `import { undo } from "undo-eve/agent"; export default undo({ ... })` in agent/extensions/undo.ts.',
    );
  }
  return c;
}
