import { defineExtension } from "eve/extension";
import { z } from "zod";

// The full config is kept by `undo()` from "undo-eve/agent" (see lib/config.ts),
// so the mount accepts any object here.
export default defineExtension({
  config: z.custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null),
});
