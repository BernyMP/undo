// Helpers for tests and the local demo: a model-free matcher and direct access
// to the ledger.
export { keywordMatch } from "../extension/lib/plan.ts";
export { setConfig, getConfig } from "../extension/lib/config.ts";
export { getStore, sweep } from "../extension/lib/runtime.ts";
export { undoRow } from "../extension/lib/undo.ts";
export { planUndo, confirmPlan } from "../extension/lib/plan.ts";
export { apiRows, historyLines } from "../extension/lib/index.ts";
export { decide as decideCall } from "../extension/lib/policy.ts";
