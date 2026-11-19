import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakes, type FakesServer } from "../src/index.ts";

let s: FakesServer;
beforeAll(async () => { s = await startFakes(); });
afterAll(async () => { await s.close(); });

const auth = { authorization: "Bearer sk_test_fake" };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function post(path: string, body: Record<string, string>, key?: string) {
  const r = await fetch(s.url + path, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-www-form-urlencoded", ...(key ? { "idempotency-key": key } : {}) },
    body: form(body),
  });
  return { status: r.status, body: await r.json() };
}

describe("fake Stripe", () => {
  it("replays a refund for the same idempotency key and refuses a changed one", async () => {
    const a = await post("/stripe/v1/refunds", { payment_intent: "pi_bob", amount: "500" }, "k1");
    const b = await post("/stripe/v1/refunds", { payment_intent: "pi_bob", amount: "500" }, "k1");
    const c = await post("/stripe/v1/refunds", { payment_intent: "pi_bob", amount: "600" }, "k1");
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(c.status).toBe(400);
    expect(s.fakes.listRefunds("pi_bob")).toHaveLength(1);
  });

  it("refuses to refund more than was captured, and captures then refunds", async () => {
    expect((await post("/stripe/v1/refunds", { payment_intent: "pi_carol" })).status).toBe(400);
    expect((await post("/stripe/v1/payment_intents/pi_carol/capture", {})).body.status).toBe("succeeded");
    expect((await post("/stripe/v1/refunds", { payment_intent: "pi_carol" })).body.amount).toBe(5000);
    expect((await post("/stripe/v1/refunds", { payment_intent: "pi_carol" })).status).toBe(400);
  });

  it("serves MCP tools with annotations", async () => {
    const r = await fetch(s.url + "/stripe/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const j = await r.json();
    const names = j.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["retrieve_customer", "create_refund", "create_coupon"]));
    expect(j.result.tools.find((t: any) => t.name === "retrieve_customer").annotations.readOnlyHint).toBe(true);
  });
});

describe("fake Resend", () => {
  it("cancels a scheduled email until it is delivered", async () => {
    const at = new Date(Date.now() + 400).toISOString();
    const send = await fetch(s.url + "/resend/emails", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "bob@example.com", subject: "hi", text: "x", scheduled_at: at }),
    }).then((r) => r.json());
    const late = await fetch(s.url + "/resend/emails", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ to: "carol@example.com", subject: "hi", text: "x", scheduled_at: at }),
    }).then((r) => r.json());
    const cancel = await fetch(`${s.url}/resend/emails/${send.id}/cancel`, { method: "POST", headers: auth });
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 700));
    expect(s.fakes.email(send.id).last_event).toBe("canceled");
    expect(s.fakes.email(late.id).last_event).toBe("delivered");
    const tooLate = await fetch(`${s.url}/resend/emails/${late.id}/cancel`, { method: "POST", headers: auth });
    expect(tooLate.status).toBe(422);
  });
});
