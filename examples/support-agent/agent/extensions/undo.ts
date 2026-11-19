import { keywordMatch, undo } from "undo-eve/agent";
import { FAKES_URL, HOLD, LEDGER } from "../lib/env.ts";
import { scriptedReview } from "../lib/review.ts";

// undo, pointed at the local fakes with a scripted reviewer and matcher, so the
// demo spends nothing. For real services, drop `services`, `review` and `match`
// and give each service a token (see the README).
export default undo({
  hold: HOLD,
  adapters: { stripe: "stripe", resend: "resend" },
  approve: {
    // A coupon over 50% needs a person; smaller ones go to the reviewer.
    stripe__create_coupon: ({ input }) => ((input as { percent_off?: number })?.percent_off ?? 0) > 50 ? "human" : "agent",
  },
  services: {
    stripe: { baseUrl: `${FAKES_URL}/stripe`, token: "sk_test_fake" },
    resend: { baseUrl: `${FAKES_URL}/resend`, token: "re_test_fake", from: "support@shop.example" },
  },
  review: scriptedReview,
  match: keywordMatch,
  store: { path: LEDGER },
});
