import { defineChannel, GET, POST } from "eve/channels";
import { apiRows, confirmPlan, getConfig, PAGE_HTML_EXPORT, pageEnabled, planUndo, undoRow } from "../lib/page-exports.ts";

const notFound = () => new Response("Not found", { status: 404 });
const on = () => Boolean(getConfig()) && pageEnabled();

// The ledger page and its API. Unauthenticated, so off in production builds.
export default defineChannel({
  routes: [
    GET("/undo", async () => (on() ? new Response(PAGE_HTML_EXPORT, { headers: { "content-type": "text/html; charset=utf-8" } }) : notFound())),
    GET("/undo/api/rows", async () => (on() ? Response.json(await apiRows()) : notFound())),
    POST("/undo/api/rows/:rowId/undo", async (_req, { params }) => (on() ? Response.json(await undoRow(params.rowId, "ledger")) : notFound())),
    POST("/undo/api/plan", async (req) => {
      if (!on()) return notFound();
      const body = (await req.json().catch(() => ({}))) as { sentence?: string };
      if (!body.sentence?.trim()) return Response.json({ error: "say what to undo" }, { status: 400 });
      return Response.json(await planUndo(body.sentence.trim()));
    }),
    POST("/undo/api/plan/:planId/confirm", async (_req, { params }) => {
      if (!on()) return notFound();
      const result = await confirmPlan(params.planId, "ledger");
      return Response.json(result, { status: "error" in result ? 409 : 200 });
    }),
  ],
});
