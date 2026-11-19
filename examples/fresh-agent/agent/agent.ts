// File 2 of 2. mockModel keeps this fixture free of model calls.
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { undoPolicy } from "undo-eve/agent";

export default defineAgent({
  model: mockModel({
    respond: ({ toolResults }) => (toolResults.length === 0 ? { toolCalls: [{ name: "lookup_order", input: { id: "1001" } }] } : "Order 1001 has shipped."),
  }),
  approval: undoPolicy(),
});
