import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import type config from "./evals.config.ts";

// Done #10: the agent calls undo__undo on its own email, and Resend cancels it.
export default defineEval<typeof config>({
  async test(t) {
    await t.send("Email Bob about his order, then take it back.");
    t.succeeded();
    t.calledTool("undo__undo", { output: (v) => JSON.stringify(v).includes('"cancelled"'), count: 1 });
    const email = Object.values(t.context.fakes.fakes.state.emails).find((e) => e.subject === "Order update");
    t.check(email?.last_event, equals("canceled"));
  },
});
