// File 1 of 2. The scripted `review` keeps this fixture free of model calls.
import { undo } from "undo-eve/agent";

export default undo({ review: () => ({ verdict: "approve", reason: "fixture" }), store: { path: process.env.UNDO_LEDGER } });
