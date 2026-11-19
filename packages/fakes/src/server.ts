import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { FakeError, Fakes, type LogEntry } from "./state.ts";

// One local server for fake Stripe (REST + MCP) and fake Resend (REST).
//
//   /stripe/v1/...        Stripe-shaped REST (form-encoded or JSON bodies, Idempotency-Key)
//   /stripe/mcp           Streamable HTTP MCP with retrieve_customer, list_payment_intents,
//                         create_refund and create_coupon
//   /resend/emails...     Resend-shaped REST (scheduled_at, cancel)
//   /_log  /_state  /_reset  /_admin/...   inspection and test helpers

export type FakesServer = { url: string; fakes: Fakes; close(): Promise<void> };

export async function startFakes(opts: { port?: number; host?: string } = {}): Promise<FakesServer> {
  const fakes = new Fakes();
  const tick = setInterval(() => fakes.deliverDue(), 250);
  tick.unref();

  const server = createServer((req, res) => {
    handle(fakes, req, res).catch((err) => {
      send(res, 500, { error: { type: "api_error", message: String(err?.message ?? err) } });
    });
  });
  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://${host}:${port}`,
    fakes,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(raw: string, contentType: string | undefined): Record<string, any> {
  if (!raw) return {};
  if (contentType?.includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function handle(fakes: Fakes, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://fakes");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // --- inspection ---
  if (path === "/_health") return send(res, 200, { ok: true });
  if (path === "/_log") {
    const service = url.searchParams.get("service");
    return send(res, 200, fakes.state.log.filter((l) => !service || l.service === service));
  }
  if (path === "/_state") {
    fakes.deliverDue();
    const { idempotency, log, ...rest } = fakes.state;
    return send(res, 200, rest);
  }
  if (path === "/_reset" && method === "POST") {
    fakes.reset();
    return send(res, 200, { ok: true });
  }

  if (path === "/stripe/mcp") return handleMcp(fakes, req, res);

  const raw = method === "GET" ? "" : await readBody(req);
  let body: Record<string, any> = {};
  try {
    body = parseBody(raw, req.headers["content-type"]);
  } catch {
    return send(res, 400, { error: { type: "invalid_request_error", message: "Malformed body." } });
  }
  const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? undefined;

  // --- admin: a person editing data by hand, outside the agent ---
  const admin = path.match(/^\/_admin\/stripe\/customers\/([^/]+)\/balance_transactions$/);
  if (admin && method === "POST") {
    return respond(fakes, res, { service: "stripe", via: "admin", method, path, body }, () => ({
      status: 200,
      body: fakes.createBalanceTransaction(admin[1]!, body),
    }));
  }

  if (path.startsWith("/stripe/") || path.startsWith("/resend/")) {
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return send(res, 401, { error: { type: "authentication_error", message: "Missing bearer token." } });
    }
  }

  const service = path.startsWith("/resend/") ? "resend" : "stripe";
  const entry = { service, via: "rest", method, path, body: method === "GET" ? undefined : body, idempotencyKey } as const;
  const fingerprint = `${method} ${path} ${JSON.stringify(body)}`;
  const route = matchRoute(fakes, method, path, url, body);
  if (!route) return send(res, 404, { error: { type: "invalid_request_error", message: `Unrecognized request URL (${method}: ${path}).` } });

  if (method === "GET") return respond(fakes, res, entry, route, { log: false });
  const result = fakes.idempotent(service, idempotencyKey, fingerprint, () => run(route));
  fakes.state.log.push({ ...entry, at: new Date().toISOString(), status: result.status, replayed: result.replayed });
  return send(res, result.status, result.body, result.replayed ? { "idempotent-replayed": "true" } : {});
}

type Route = () => { status: number; body: unknown };

function run(route: Route) {
  try {
    return route();
  } catch (err) {
    if (err instanceof FakeError) return { status: err.status, body: { error: { type: err.type, message: err.message } } };
    throw err;
  }
}

function respond(
  fakes: Fakes,
  res: ServerResponse,
  entry: Omit<LogEntry, "at" | "status">,
  route: Route,
  opts: { log?: boolean } = {},
) {
  const result = run(route);
  if (opts.log !== false) fakes.state.log.push({ ...entry, at: new Date().toISOString(), status: result.status });
  return send(res, result.status, result.body);
}

function matchRoute(fakes: Fakes, method: string, path: string, url: URL, body: Record<string, any>): Route | undefined {
  let m: RegExpMatchArray | null;
  const ok = (b: unknown) => ({ status: 200, body: b });
  // Stripe
  if (method === "GET" && (m = path.match(/^\/stripe\/v1\/customers\/([^/]+)$/))) return () => ok(fakes.customer(m![1]!));
  if (method === "GET" && (m = path.match(/^\/stripe\/v1\/payment_intents\/([^/]+)$/))) return () => ok(fakes.paymentIntent(m![1]!));
  if (method === "GET" && path === "/stripe/v1/payment_intents")
    return () => ok({ object: "list", data: fakes.listPaymentIntents(url.searchParams.get("customer") ?? undefined) });
  if (method === "POST" && (m = path.match(/^\/stripe\/v1\/payment_intents\/([^/]+)\/capture$/))) return () => ok(fakes.capture(m![1]!, body));
  if (method === "GET" && path === "/stripe/v1/refunds")
    return () => ok({ object: "list", data: fakes.listRefunds(url.searchParams.get("payment_intent") ?? undefined) });
  if (method === "POST" && path === "/stripe/v1/refunds") return () => ok(fakes.createRefund(body));
  if ((m = path.match(/^\/stripe\/v1\/customers\/([^/]+)\/balance_transactions$/))) {
    if (method === "GET") return () => ok({ object: "list", data: fakes.listBalanceTransactions(m![1]!) });
    if (method === "POST") return () => ok(fakes.createBalanceTransaction(m![1]!, body));
  }
  if (method === "POST" && path === "/stripe/v1/coupons") return () => ok(fakes.createCoupon(body));
  // Resend
  if (method === "POST" && path === "/resend/emails") return () => ok(fakes.sendEmail(body));
  if (method === "GET" && (m = path.match(/^\/resend\/emails\/([^/]+)$/))) return () => ok(fakes.email(m![1]!));
  if (method === "POST" && (m = path.match(/^\/resend\/emails\/([^/]+)\/cancel$/))) return () => ok(fakes.cancelEmail(m![1]!));
  return undefined;
}

// --- MCP: a small Stripe-like MCP server, stateless ---

function mcpServer(fakes: Fakes) {
  const server = new McpServer({ name: "fake-stripe", version: "0.0.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const fail = (err: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  });
  const logged = (name: string, args: unknown, fn: () => unknown) => {
    try {
      const value = fn();
      fakes.state.log.push({ at: new Date().toISOString(), service: "stripe", via: "mcp", method: "TOOL", path: name, body: args, status: 200 });
      return result(value);
    } catch (err) {
      fakes.state.log.push({
        at: new Date().toISOString(),
        service: "stripe",
        via: "mcp",
        method: "TOOL",
        path: name,
        body: args,
        status: err instanceof FakeError ? err.status : 500,
      });
      return fail(err);
    }
  };

  server.registerTool(
    "retrieve_customer",
    {
      description: "Retrieve a Stripe customer by id.",
      inputSchema: { customer: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ customer }) => {
      try {
        return result(fakes.customer(customer));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_payment_intents",
    {
      description: "List payment intents, optionally for one customer.",
      inputSchema: { customer: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ customer }) => result({ object: "list", data: fakes.listPaymentIntents(customer) }),
  );
  server.registerTool(
    "create_refund",
    {
      description: "Refund a payment intent. Final once created.",
      inputSchema: { payment_intent: z.string(), amount: z.number().int().optional(), reason: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async (args) => logged("create_refund", args, () => fakes.createRefund(args)),
  );
  server.registerTool(
    "create_coupon",
    {
      description: "Create a coupon.",
      inputSchema: { percent_off: z.number(), duration: z.enum(["once", "repeating", "forever"]).optional() },
    },
    async (args) => logged("create_coupon", args, () => fakes.createCoupon(args)),
  );
  return server;
}

async function handleMcp(fakes: Fakes, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" }, { allow: "POST" });
  const raw = await readBody(req);
  const server = mcpServer(fakes);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
}
