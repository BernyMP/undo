import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEvalConfig } from "eve/evals";
import { startFakes } from "undo-fakes";

// Start fake Stripe and Resend before eve starts the agent, and point the agent
// at them. Scripted models and a scripted reviewer: no model provider is called.
export default defineEvalConfig({
  timeoutMs: 120_000,
  async setup() {
    const fakes = await startFakes({ port: Number(process.env.FAKES_PORT ?? 4599) });
    process.env.FAKES_URL = fakes.url;
    process.env.UNDO_HOLD = "5s";
    process.env.UNDO_LEDGER = join(mkdtempSync(join(tmpdir(), "undo-eval-")), "ledger.db");
    return { fakes };
  },
  async teardown(context) {
    await context?.fakes.close();
  },
});
