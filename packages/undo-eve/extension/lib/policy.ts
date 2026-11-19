// undoPolicy's decision for one call. Writes the row before the call runs,
// then approves, denies, reviews or asks a person.

import { classify, summarize } from "./classify.ts";
import { getConfig, type ReviewFn, type ReviewVerdict, type RowSummary } from "./config.ts";
import { getStore } from "./runtime.ts";
import type { Row } from "./store.ts";

export type PolicyCall = {
  toolName: string;
  toolInput?: unknown;
  toolAnnotations?: { readOnlyHint?: boolean; [k: string]: unknown };
  callId: string;
  session: { id: string };
  abortSignal?: AbortSignal;
};

export type PolicyStatus = undefined | "approved" | "user-approval" | { type: "denied"; reason: string };

const REVIEW_TIMEOUT_MS = 30_000;
const loggedWrites: Set<string> = ((globalThis as any)[Symbol.for("undo-eve.logged-writes")] ??= new Set());

export function toSummary(r: Row): RowSummary {
  return {
    rowId: r.rowId,
    sessionId: r.sessionId,
    tool: r.tool,
    summary: r.summary,
    state: r.state,
    strategy: r.strategy,
    createdAt: r.createdAt,
    input: r.input,
  };
}

export async function decide(call: PolicyCall): Promise<PolicyStatus> {
  const cfg = getConfig();
  if (!cfg) return { type: "denied", reason: 'undo is not mounted: mount undo with `undo()` from "undo-eve/agent" in agent/extensions/undo.ts' };
  const store = await getStore();
  const sessionId = call.session.id;

  const existing = store.getByCall(sessionId, call.callId);
  if (existing) {
    // eve runs the policy again after a person approves a call: let it run, don't review again.
    if (existing.state === "awaiting_person") {
      store.transition(existing.rowId, "awaiting_person", "requested");
      return "approved";
    }
    if (existing.state === "blocked") return { type: "denied", reason: existing.reviewReason ?? "blocked" };
    return undefined;
  }

  const c = classify(cfg, call);
  const base = {
    sessionId,
    callId: call.callId,
    tool: call.toolName,
    input: call.toolInput ?? {},
    summary: summarize(call.toolName, call.toolInput),
  };

  if (c.kind === "deny") {
    store.upsertRow({ ...base, kind: "write", strategy: "none", approve: "none", state: "blocked", reviewReason: c.reason });
    return { type: "denied", reason: c.reason };
  }

  if (c.approve === "none") {
    store.upsertRow({ ...base, kind: c.kind, strategy: c.strategy, approve: c.approve, state: "requested" });
    return undefined;
  }

  if (c.approve === "human") {
    store.upsertRow({ ...base, kind: c.kind, strategy: c.strategy, approve: c.approve, state: "awaiting_person" });
    return "user-approval";
  }

  if (c.kind === "write" && !loggedWrites.has(call.toolName)) {
    loggedWrites.add(call.toolName);
    console.info(`[undo] reviewing ${call.toolName} as a write (approve: ${c.approve}). If it only reads, add it to \`reads\` in agent/extensions/undo.ts.`);
  }

  // approve: "agent" -> the reviewer, before the call and before any hold.
  let verdict: ReviewVerdict;
  try {
    const review: ReviewFn = cfg.review ?? defaultReview;
    const context = {
      sessionId,
      messages: store.messages(sessionId),
      rows: store.list({ sessionId, limit: 30 }).map(toSummary),
      signal: call.abortSignal,
    };
    verdict = await withTimeout(Promise.resolve(review({ toolName: call.toolName, input: call.toolInput, summary: base.summary }, context)));
    if (verdict?.verdict !== "approve" && verdict?.verdict !== "block") throw new Error("the reviewer returned no verdict");
  } catch (err) {
    const key = `${call.toolName} ${JSON.stringify(call.toolInput ?? {})}`;
    const count = store.bumpReviewFailure(sessionId, key);
    const reason = count >= 2 ? "review unavailable; don't retry, report it" : "review unavailable, try once more";
    console.warn(`[undo] review failed for ${call.toolName}: ${err instanceof Error ? err.message : String(err)}`);
    store.upsertRow({ ...base, kind: c.kind, strategy: c.strategy, approve: c.approve, state: "blocked", reviewReason: reason });
    return { type: "denied", reason };
  }

  if (verdict.verdict === "block") {
    const reason = `blocked by reviewer: ${verdict.reason}`;
    store.upsertRow({
      ...base,
      kind: c.kind,
      strategy: c.strategy,
      approve: c.approve,
      state: "blocked",
      reviewVerdict: "block",
      reviewReason: reason,
    });
    return { type: "denied", reason };
  }
  store.upsertRow({
    ...base,
    kind: c.kind,
    strategy: c.strategy,
    approve: c.approve,
    state: "requested",
    reviewVerdict: "approve",
    reviewReason: verdict.reason,
  });
  return "approved";
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the reviewer took longer than ${REVIEW_TIMEOUT_MS / 1000}s`)), REVIEW_TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Default reviewer: eve's `decide` through AI Gateway. Not used by the local demo or tests. */
export const defaultReview: ReviewFn = async (call, context) => {
  const { decide: ask } = await import("eve/ai");
  const result = await ask({
    state: {
      action: { tool: call.toolName, input: call.input, summary: call.summary },
      conversation: context.messages.slice(-10),
      earlierActions: context.rows.slice(0, 15).map((r) => `${r.rowId} ${r.summary} (${r.state})`),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent wants to take this action on its own. Approve it only if it clearly matches what the conversation asked for.",
        criteria: REVIEW_CRITERIA,
      },
    },
    signal: context.signal,
  } as any);
  const choice = (result as any).answers.verdict.choice as keyof typeof REVIEW_CRITERIA;
  return { verdict: choice === "approve" ? "approve" : "block", reason: REVIEW_CRITERIA[choice] ?? REVIEW_CRITERIA.other };
};

export const REVIEW_CRITERIA = {
  approve: "the action matches what the conversation asked for",
  wrong_customer: "the action targets a different customer or recipient than the conversation names",
  wrong_amount: "the amount differs from what the conversation asked for",
  not_requested: "nothing in the conversation asked for this action",
  other: "the action doesn't clearly match the conversation",
} as const;

/** The stricter of two statuses: denied, then user approval, then approved. */
export function stricter(a: any, b: any): any {
  const rank = (s: any) => {
    if (s === undefined || s === null || s === false || s === "not-applicable" || s?.type === "not-applicable") return 0;
    if (s === "approved" || s?.type === "approved") return 1;
    if (s === true || s === "user-approval") return 2;
    if (s === "denied" || s?.type === "denied") return 3;
    return 0;
  };
  return rank(b) > rank(a) ? b : a;
}
