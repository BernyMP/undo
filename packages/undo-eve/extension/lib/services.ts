// Minimal Stripe and Resend clients for the adapters. They speak the real APIs'
// shapes, so pointing `services.<name>.baseUrl` at the local fakes or at the real
// API is the only change.

import { requireConfig, type ServiceConfig } from "./config.ts";

export class ServiceError extends Error {
  service: string;
  status: number;
  body?: unknown;
  constructor(service: string, status: number, message: string, body?: unknown) {
    super(message);
    this.service = service;
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_BASE = { stripe: "https://api.stripe.com", resend: "https://api.resend.com" } as const;

async function serviceConfig(service: "stripe" | "resend"): Promise<{ baseUrl: string; token: string }> {
  const cfg: ServiceConfig | undefined = requireConfig().services?.[service];
  const baseUrl = (cfg?.baseUrl ?? DEFAULT_BASE[service]).replace(/\/$/, "");
  const token = typeof cfg?.token === "function" ? await cfg.token() : cfg?.token;
  if (!token) {
    throw new ServiceError(
      service,
      0,
      `undo: no token for ${service}. Set services.${service}.token in agent/extensions/undo.ts, for example () => getToken("<connector>", { subject: { type: "app" } }) from @vercel/connect.`,
    );
  }
  return { baseUrl, token };
}

async function request(
  service: "stripe" | "resend",
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<any> {
  const { baseUrl, token } = await serviceConfig(service);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let payload: string | undefined;
  if (body && method === "POST") {
    if (service === "stripe") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(
        Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]),
      ).toString();
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(baseUrl + path, { method, headers, body: payload });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = json?.error?.message ?? json?.message ?? `${service} returned ${res.status}`;
    throw new ServiceError(service, res.status, message, json);
  }
  return json;
}

export const stripe = {
  paymentIntent: (id: string) => request("stripe", "GET", `/v1/payment_intents/${encodeURIComponent(id)}`),
  refunds: async (paymentIntent: string) =>
    (await request("stripe", "GET", `/v1/refunds?payment_intent=${encodeURIComponent(paymentIntent)}`)).data as any[],
  createRefund: (params: { payment_intent: string; amount?: number; reason?: string }, idempotencyKey: string) =>
    request("stripe", "POST", "/v1/refunds", params, idempotencyKey),
  capture: (paymentIntent: string, params: { amount_to_capture?: number }, idempotencyKey: string) =>
    request("stripe", "POST", `/v1/payment_intents/${encodeURIComponent(paymentIntent)}/capture`, params, idempotencyKey),
};

export const resend = {
  send: (params: { from: string; to: string; subject: string; text: string; scheduled_at?: string }, idempotencyKey: string) =>
    request("resend", "POST", "/emails", params, idempotencyKey),
  get: (id: string) => request("resend", "GET", `/emails/${encodeURIComponent(id)}`),
  cancel: (id: string) => request("resend", "POST", `/emails/${encodeURIComponent(id)}/cancel`),
};
