import { defineMcpClientConnection } from "eve/connections";
import { FAKES_URL } from "../lib/env.ts";

// The local fake Stripe MCP. With real Stripe, use its MCP URL and
// `auth: connect("<connector>")` from "@vercel/connect/eve" instead.
export default defineMcpClientConnection({
  url: `${FAKES_URL}/stripe/mcp`,
  description: "The shop's Stripe account (test mode): customers, payment intents, refunds and coupons.",
});
