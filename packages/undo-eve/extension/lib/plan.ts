// Undo in one sentence: turn a sentence into ledger rows with `match`, then
// either undo them (one clear match) or return a question with candidates.

import { requireConfig, type MatchFn, type MatchResult, type RowSummary } from "./config.ts";
import { toSummary } from "./policy.ts";
import { getStore } from "./runtime.ts";
import { canUndo, undoRow, type UndoResult } from "./undo.ts";

export type PlanResult =
  | { planId: string; rows: RowSummary[] }
  | { question: string; candidates: RowSummary[] };

export async function candidates(scope: { sessionId?: string } = {}): Promise<RowSummary[]> {
  const store = await getStore();
  return store
    .list({ sessionId: scope.sessionId, limit: 200 })
    .filter(canUndo)
    .map(toSummary);
}

export async function planUndo(sentence: string, scope: { sessionId?: string } = {}): Promise<PlanResult> {
  const cfg = requireConfig();
  const rows = await candidates(scope);
  if (rows.length === 0) return { question: "Nothing can be undone right now.", candidates: [] };
  const match: MatchFn = cfg.match ?? defaultMatch;
  const result: MatchResult = await match(sentence, rows);
  const picked = rows.filter((r) => result.rowIds.includes(r.rowId));
  if (picked.length === 0 || result.question) {
    return { question: result.question ?? `Which one do you mean by "${sentence}"?`, candidates: rows.slice(0, 10) };
  }
  const store = await getStore();
  const planId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  store.savePlan({ planId, sentence, rowIds: picked.map((r) => r.rowId), createdAt: Date.now(), confirmedAt: null });
  return { planId, rows: picked };
}

export async function confirmPlan(planId: string, actor = "ledger"): Promise<{ results: UndoResult[] } | { error: string }> {
  const store = await getStore();
  const plan = store.confirmPlan(planId);
  if (!plan) return { error: store.getPlan(planId) ? "this plan already ran" : "no such plan" };
  const results: UndoResult[] = [];
  for (const rowId of plan.rowIds) results.push(await undoRow(rowId, actor));
  return { results };
}

/** Default matcher: eve's `decide` through AI Gateway. Not used by the local demo or tests. */
export const defaultMatch: MatchFn = async (sentence, rows) => {
  const { decide } = await import("eve/ai");
  const criteria: Record<string, string> = {
    none: "None of these actions is what the person means.",
    several: "The sentence could mean more than one of these actions.",
  };
  for (const r of rows.slice(0, 20)) criteria[r.rowId] = `${r.summary} (${r.state})`;
  const result: any = await decide({
    state: { request: sentence },
    questions: {
      row: { type: "choice", instructions: "Which action does the person want undone?", criteria },
    },
  } as any);
  const choice = result.answers.row.choice as string;
  if (choice === "none") return { rowIds: [], question: `I couldn't find "${sentence}". Which one do you mean?` };
  if (choice === "several") return { rowIds: [], question: `"${sentence}" could mean several actions. Which one?` };
  return { rowIds: [choice] };
};

const STOP = new Set([
  "undo", "cancel", "reverse", "revert", "the", "a", "an", "to", "for", "of", "and", "please", "that", "this", "it",
  "my", "me", "on", "in", "from", "just", "you", "your", "sent", "made",
]);
const SYNONYMS: Record<string, string[]> = { email: ["email", "mail", "message"], refund: ["refund", "money back"], capture: ["capture", "charge"] };

/**
 * A model-free matcher for tests, the local demo and offline use. It scores rows
 * by the words they share with the sentence. One best row wins; a tie or no
 * shared words returns a question.
 */
export const keywordMatch: MatchFn = (sentence, rows) => {
  const words = sentence
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  if (words.length === 0) return { rowIds: [], question: `Which one do you mean by "${sentence}"?` };
  const scored = rows.map((r) => {
    const hay = `${r.tool} ${r.summary} ${JSON.stringify(r.input)}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w) || (SYNONYMS[w] ?? []).some((s) => hay.includes(s))).length;
    return { r, score };
  });
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  if (best === 0 || top.length !== 1) return { rowIds: [], question: `Which one do you mean by "${sentence}"?` };
  return { rowIds: [top[0]!.r.rowId] };
};
