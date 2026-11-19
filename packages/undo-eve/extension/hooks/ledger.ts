import { call } from "eve/events";
import { defineHook } from "eve/hooks";
import { getConfig, getStore, summarize, UNGATED } from "../lib/index.ts";

let warned = false;

// Fills in each row's result after the call settles, and keeps the session's
// user messages as context for the reviewer.
export default defineHook({
  events: {
    async "delivery.consumed"(event, ctx) {
      if (!getConfig()) return;
      const parts = ((event as any).data?.parts ?? []) as Array<{ kind?: string; text?: string }>;
      const text = parts.filter((p) => p.kind === "text" && p.text).map((p) => p.text).join("\n");
      if (text) (await getStore()).addMessage(ctx.session.id, text);
    },
    async "call.settled"(event, ctx) {
      if (!getConfig()) return;
      const data = (event as any).data ?? {};
      const observed: any = call(ctx.view, data.callId);
      const store = await getStore();
      let row = store.getByCall(ctx.session.id, data.callId);
      if (!row) {
        const name = observed?.name ?? data.name ?? "unknown";
        if (name === "eve__reply") return;
        if (UNGATED.has(name)) {
          // eve doesn't send these to the policy; record them after the fact.
          row = store.upsertRow({
            sessionId: ctx.session.id,
            callId: data.callId,
            tool: name,
            input: observed?.input ?? {},
            summary: summarize(name, observed?.input),
            kind: "read",
            strategy: "none",
            approve: "none",
            state: "requested",
          });
        } else if (!warned) {
          warned = true;
          console.warn("[undo] undoPolicy is not set in agent.ts: calls are recorded after they run, without review. Add `approval: undoPolicy()`.");
        }
        row ??= store.upsertRow({
          sessionId: ctx.session.id,
          callId: data.callId,
          tool: name,
          input: observed?.input ?? {},
          summary: summarize(name, observed?.input),
          kind: "write",
          strategy: "none",
          approve: "none",
          state: "requested",
        });
      }
      const output = data.output ?? observed?.output;
      const outcome: string = data.outcome ?? observed?.state;
      if (outcome === "completed") {
        store.update(row.rowId, { output });
        if (row.state === "requested") {
          const next = row.kind === "write" ? "irreversible" : "done";
          store.transition(row.rowId, "requested", next);
        }
      } else if (outcome === "rejected") {
        store.transition(row.rowId, ["requested", "awaiting_person"], "blocked", {
          reviewReason: row.reviewReason ?? "denied",
          output,
        });
      } else if (outcome === "failed" || outcome === "interrupted") {
        const error = typeof data.error === "string" ? data.error : (data.error?.message ?? JSON.stringify(data.error ?? outcome));
        store.transition(row.rowId, ["requested", "awaiting_person"], "failed", { error });
      }
    },
  },
});
