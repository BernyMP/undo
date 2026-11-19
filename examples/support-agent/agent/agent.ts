import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { undoPolicy } from "undo-eve/agent";
import { respond } from "./lib/script.ts";

// The demo's support agent. Its model is scripted (no provider, no cost); swap
// `model` for e.g. "anthropic/claude-sonnet-5.5" to run it on a real model.
export default defineAgent({
  model: mockModel({ modelId: "support-script", provider: "undo-demo", respond }),
  defaultTools: false,
  approval: undoPolicy(),
});
