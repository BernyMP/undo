import { defineChannel, GET, POST } from "eve/channels";
import { apiRows, confirmPlan, getConfig, PAGE_HTML_EXPORT, pageEnabled, planUndo, undoRow } from "../lib/page-exports.ts";

const notFound = () => new Response("Not found", { status: 404 });
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Only under eve dev, and only for requests addressed to this machine (no tunnels, no DNS rebinding). */
const on = (req: Request) => Boolean(getConfig()) && pageEnabled() && LOOPBACK.has(new URL(req.url).hostname);

/** Refuse cross-site POSTs: they must be JSON, and any Origin must be this server. */
function foreign(req: Request): Response | undefined {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: "send content-type: application/json" }, { status: 415 });
  }
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  return undefined;
}

// The ledger page and its API. Unauthenticated, so off in production builds.
export default defineChannel({
  routes: [
    GET("/undo", async (req) => (on(req) ? new Response(PAGE_HTML_EXPORT, { headers: { "content-type": "text/html; charset=utf-8" } }) : notFound())),
    GET("/undo/api/rows", async (req) => (on(req) ? Response.json(await apiRows()) : notFound())),
    POST("/undo/api/rows/:rowId/undo", async (req, { params }) => {
      if (!on(req)) return notFound();
      return foreign(req) ?? Response.json(await undoRow(params.rowId, "ledger"));
    }),
    POST("/undo/api/plan", async (req) => {
      if (!on(req)) return notFound();
      const refused = foreign(req);
      if (refused) return refused;
      const body = (await req.json().catch(() => ({}))) as { sentence?: string };
      if (!body.sentence?.trim()) return Response.json({ error: "say what to undo" }, { status: 400 });
      return Response.json(await planUndo(body.sentence.trim()));
    }),
    POST("/undo/api/plan/:planId/confirm", async (req, { params }) => {
      if (!on(req)) return notFound();
      const refused = foreign(req);
      if (refused) return refused;
      const result = await confirmPlan(params.planId, "ledger");
      return Response.json(result, { status: "error" in result ? 409 : 200 });
    }),
  ],
});
