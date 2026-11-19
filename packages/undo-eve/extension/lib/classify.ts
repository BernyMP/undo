// How undoPolicy sorts a call. First matching rule wins:
//
// 1. undo's own tools: history/undo run with no review; adapters use their own
//    strategy and approve.
// 2. A connection write an adapter covers: denied with the adapter's name.
// 3. Reads: MCP readOnlyHint, each adapter's service reads, eve's read tools, `reads`.
// 4. reversible() tools: strategy reverse.
// 5. eve's sandbox tools and subagent calls: approve none, strategy none.
// 6. Everything else: strategy none (irreversible), approve from config.
//
// No name guessing: an unannotated connection tool that nobody lists is a write.

import { ADAPTERS, SERVICE_READS, adapterByTool } from "./adapters.ts";
import type { Approve, ApproveRule, ResolvedConfig } from "./config.ts";
import { getReversible } from "./registry.ts";
import type { RowKind, Strategy } from "./store.ts";

export const EVE_READS = new Set([
  "read_file",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "eve__search",
  "eve__skill",
  "eve__task_wait",
  "eve__task_cancel",
  "ask_question",
  "no_reply",
  "sleep",
]);
export const EVE_SANDBOX = new Set(["bash", "write_file", "edit_file"]);
/** eve doesn't send these to the approval policy; the hook records them. */
export const UNGATED = { has: (name: string) => name.startsWith("eve__") || ["ask_question", "no_reply", "sleep", "web_search"].includes(name) };
export const UNDO_OWN = new Set(["undo__history", "undo__undo"]);

export type Classification =
  | { kind: "deny"; reason: string; strategy: "none"; approve: "none" }
  | { kind: RowKind; strategy: Strategy; approve: Approve };

function resolveApprove(rule: ApproveRule | undefined, toolName: string, input: unknown): Approve | undefined {
  if (rule === undefined) return undefined;
  return typeof rule === "function" ? rule({ toolName, input }) : rule;
}

export function holdText(ms: number) {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function classify(
  cfg: ResolvedConfig,
  call: { toolName: string; toolInput?: unknown; toolAnnotations?: { readOnlyHint?: boolean } },
): Classification {
  const { toolName } = call;
  const input = call.toolInput;
  const override = resolveApprove(cfg.approve[toolName], toolName, input);

  // 1. undo's own tools
  if (UNDO_OWN.has(toolName)) return { kind: "undo", strategy: "none", approve: "none" };
  const adapter = adapterByTool(toolName);
  if (adapter) return { kind: "adapter", strategy: adapter.strategy, approve: override ?? adapter.defaultApprove };

  // 2. connection writes an adapter covers
  for (const a of ADAPTERS) {
    const conn = cfg.adapters[a.service];
    if (!conn) continue;
    if (a.covers.some((w) => toolName === `${conn}__${w}`)) {
      const terms = a.strategy === "cancel" ? `it can be undone for ${holdText(cfg.holdMs)}` : "it can be undone later";
      return {
        kind: "deny",
        reason: `use ${a.tool}; ${terms}. If you don't have ${a.tool}, this write isn't allowed here.`,
        strategy: "none",
        approve: "none",
      };
    }
  }

  // 3. reads
  const serviceReads = (Object.keys(SERVICE_READS) as Array<keyof typeof SERVICE_READS>).flatMap((svc) => {
    const conn = cfg.adapters[svc];
    return conn ? SERVICE_READS[svc].map((r) => `${conn}__${r}`) : [];
  });
  if (
    call.toolAnnotations?.readOnlyHint === true ||
    EVE_READS.has(toolName) ||
    toolName.startsWith("eve__") ||
    serviceReads.includes(toolName) ||
    cfg.reads.includes(toolName)
  ) {
    return { kind: "read", strategy: "none", approve: "none" };
  }

  // 4. reversible() tools
  const rev = getReversible(toolName);
  if (rev) return { kind: "reversible", strategy: "reverse", approve: override ?? rev.approve ?? cfg.defaultApprove };

  // 5. sandbox and subagents
  if (EVE_SANDBOX.has(toolName)) return { kind: "sandbox", strategy: "none", approve: override ?? "none" };
  if (toolName === "agent" || cfg.subagents.includes(toolName)) return { kind: "subagent", strategy: "none", approve: override ?? "none" };

  // 6. everything else is a write with no inverse
  return { kind: "write", strategy: "none", approve: override ?? cfg.defaultApprove };
}

export function summarize(toolName: string, input: unknown): string {
  const adapter = adapterByTool(toolName);
  if (adapter) return adapter.summary(input);
  const rev = getReversible(toolName);
  if (rev?.summary) return rev.summary(input);
  let json = "";
  try {
    json = JSON.stringify(input ?? {});
  } catch {
    json = String(input);
  }
  return `${toolName} ${json.length > 140 ? json.slice(0, 137) + "..." : json}`;
}
