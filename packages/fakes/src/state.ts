// In-memory state for the fake Stripe and Resend. Behaves like test mode:
// idempotency keys, a scheduled email that can be cancelled until it sends,
// refunds that are final once created, and captures that can be refunded.

export type LogEntry = {
  at: string;
  service: "stripe" | "resend";
  via: "rest" | "mcp" | "admin";
  method: string;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  status: number;
  replayed?: boolean;
};

export type Customer = { id: string; object: "customer"; name: string; email: string; balance: number };
export type PaymentIntent = {
  id: string;
  object: "payment_intent";
  customer: string;
  amount: number;
  amount_received: number;
  amount_capturable: number;
  currency: string;
  status: "requires_capture" | "succeeded" | "canceled";
  description: string;
};
export type Refund = {
  id: string;
  object: "refund";
  amount: number;
  payment_intent: string;
  status: "succeeded";
  reason: string | null;
  created: number;
};
export type BalanceTransaction = {
  id: string;
  object: "customer_balance_transaction";
  customer: string;
  amount: number;
  currency: string;
  description: string | null;
  ending_balance: number;
  created: number;
};
export type Coupon = { id: string; object: "coupon"; percent_off: number; duration: string; created: number };
export type Email = {
  id: string;
  object: "email";
  from: string;
  to: string[];
  subject: string;
  text: string;
  scheduled_at: string | null;
  last_event: "scheduled" | "delivered" | "canceled";
  created_at: string;
};

export class FakeError extends Error {
  status: number;
  type: string;
  constructor(status: number, type: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

let counter = 0;
const id = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
const now = () => Math.floor(Date.now() / 1000);

export function seed() {
  const customers: Record<string, Customer> = {
    cus_alice: { id: "cus_alice", object: "customer", name: "Alice Doe", email: "alice@example.com", balance: 0 },
    cus_bob: { id: "cus_bob", object: "customer", name: "Bob Roe", email: "bob@example.com", balance: 0 },
    cus_carol: { id: "cus_carol", object: "customer", name: "Carol Poe", email: "carol@example.com", balance: 0 },
  };
  const paymentIntents: Record<string, PaymentIntent> = {
    pi_alice: pi("pi_alice", "cus_alice", 4200, "succeeded", "Order #1001: wool scarf"),
    pi_bob: pi("pi_bob", "cus_bob", 1800, "succeeded", "Order #1002: socks"),
    pi_carol: pi("pi_carol", "cus_carol", 5000, "requires_capture", "Order #1003: boots (authorized)"),
  };
  return {
    customers,
    paymentIntents,
    refunds: [] as Refund[],
    balanceTransactions: [] as BalanceTransaction[],
    coupons: [] as Coupon[],
    emails: {} as Record<string, Email>,
    idempotency: new Map<string, { fingerprint: string; status: number; body: unknown }>(),
    log: [] as LogEntry[],
  };
}

function pi(id: string, customer: string, amount: number, status: PaymentIntent["status"], description: string): PaymentIntent {
  return {
    id,
    object: "payment_intent",
    customer,
    amount,
    amount_received: status === "succeeded" ? amount : 0,
    amount_capturable: status === "requires_capture" ? amount : 0,
    currency: "usd",
    status,
    description,
  };
}

export type State = ReturnType<typeof seed>;

export class Fakes {
  state: State = seed();

  reset() {
    this.state = seed();
  }

  // ---- Stripe ----

  customer(customerId: string): Customer {
    const c = this.state.customers[customerId];
    if (!c) throw new FakeError(404, "invalid_request_error", `No such customer: '${customerId}'`);
    return c;
  }

  paymentIntent(piId: string): PaymentIntent {
    const p = this.state.paymentIntents[piId];
    if (!p) throw new FakeError(404, "invalid_request_error", `No such payment_intent: '${piId}'`);
    return p;
  }

  listPaymentIntents(customer?: string) {
    return Object.values(this.state.paymentIntents).filter((p) => !customer || p.customer === customer);
  }

  listRefunds(paymentIntent?: string) {
    return this.state.refunds.filter((r) => !paymentIntent || r.payment_intent === paymentIntent);
  }

  refunded(piId: string) {
    return this.listRefunds(piId).reduce((sum, r) => sum + r.amount, 0);
  }

  createRefund(params: { payment_intent?: string; amount?: number | string; reason?: string }): Refund {
    if (!params.payment_intent) throw new FakeError(400, "invalid_request_error", "Missing required param: payment_intent.");
    const p = this.paymentIntent(params.payment_intent);
    if (p.status !== "succeeded") throw new FakeError(400, "invalid_request_error", `PaymentIntent ${p.id} has no captured funds to refund.`);
    const left = p.amount_received - this.refunded(p.id);
    const amount = params.amount === undefined || params.amount === "" ? left : Number(params.amount);
    if (!Number.isInteger(amount) || amount <= 0) throw new FakeError(400, "invalid_request_error", "Invalid amount.");
    if (amount > left) throw new FakeError(400, "invalid_request_error", `Refund amount (${amount}) is greater than unrefunded amount on charge (${left}).`);
    const refund: Refund = {
      id: id("re"),
      object: "refund",
      amount,
      payment_intent: p.id,
      status: "succeeded",
      reason: params.reason ?? null,
      created: now(),
    };
    this.state.refunds.push(refund);
    return refund;
  }

  capture(piId: string, params: { amount_to_capture?: number | string }): PaymentIntent {
    const p = this.paymentIntent(piId);
    if (p.status !== "requires_capture") throw new FakeError(400, "invalid_request_error", `PaymentIntent ${p.id} is ${p.status} and can't be captured.`);
    const amount = params.amount_to_capture === undefined ? p.amount_capturable : Number(params.amount_to_capture);
    if (amount <= 0 || amount > p.amount_capturable) throw new FakeError(400, "invalid_request_error", "Invalid amount_to_capture.");
    p.status = "succeeded";
    p.amount_received = amount;
    p.amount_capturable = 0;
    return p;
  }

  createBalanceTransaction(customerId: string, params: { amount?: number | string; currency?: string; description?: string }): BalanceTransaction {
    const c = this.customer(customerId);
    const amount = Number(params.amount);
    if (!Number.isInteger(amount) || amount === 0) throw new FakeError(400, "invalid_request_error", "Invalid amount.");
    c.balance += amount;
    const tx: BalanceTransaction = {
      id: id("cbtxn"),
      object: "customer_balance_transaction",
      customer: c.id,
      amount,
      currency: params.currency ?? "usd",
      description: params.description ?? null,
      ending_balance: c.balance,
      created: now(),
    };
    this.state.balanceTransactions.push(tx);
    return tx;
  }

  listBalanceTransactions(customerId: string) {
    this.customer(customerId);
    return this.state.balanceTransactions.filter((t) => t.customer === customerId).slice().reverse();
  }

  createCoupon(params: { percent_off?: number | string; duration?: string }): Coupon {
    const coupon: Coupon = {
      id: id("co"),
      object: "coupon",
      percent_off: Number(params.percent_off ?? 10),
      duration: params.duration ?? "once",
      created: now(),
    };
    this.state.coupons.push(coupon);
    return coupon;
  }

  // ---- Resend ----

  deliverDue() {
    const t = Date.now();
    for (const e of Object.values(this.state.emails)) {
      if (e.last_event === "scheduled" && e.scheduled_at && Date.parse(e.scheduled_at) <= t) e.last_event = "delivered";
    }
  }

  sendEmail(params: { from?: string; to?: string | string[]; subject?: string; text?: string; scheduled_at?: string }): { id: string } {
    if (!params.to || !params.subject) throw new FakeError(422, "validation_error", "Missing `to` or `subject`.");
    const to = Array.isArray(params.to) ? params.to : [params.to];
    if (to.some((a) => !/^[^@\s]+@[^@\s]+$/.test(a))) throw new FakeError(422, "validation_error", "Invalid `to` address.");
    const scheduled = params.scheduled_at ? Date.parse(params.scheduled_at) : NaN;
    if (params.scheduled_at && Number.isNaN(scheduled)) throw new FakeError(422, "validation_error", "Invalid `scheduled_at`.");
    const email: Email = {
      id: crypto.randomUUID(),
      object: "email",
      from: params.from ?? "shop@example.com",
      to,
      subject: params.subject,
      text: params.text ?? "",
      scheduled_at: params.scheduled_at ?? null,
      last_event: params.scheduled_at && scheduled > Date.now() ? "scheduled" : "delivered",
      created_at: new Date().toISOString(),
    };
    this.state.emails[email.id] = email;
    return { id: email.id };
  }

  email(emailId: string): Email {
    this.deliverDue();
    const e = this.state.emails[emailId];
    if (!e) throw new FakeError(404, "not_found", "Email not found.");
    return e;
  }

  cancelEmail(emailId: string): { object: "email"; id: string } {
    const e = this.email(emailId);
    if (e.last_event !== "scheduled") throw new FakeError(422, "validation_error", `Email is ${e.last_event} and can no longer be cancelled.`);
    e.last_event = "canceled";
    return { object: "email", id: e.id };
  }

  // ---- Idempotency (Stripe and Resend both honor Idempotency-Key) ----

  idempotent(service: string, key: string | undefined, fingerprint: string, run: () => { status: number; body: unknown }) {
    if (!key) return { ...run(), replayed: false };
    const k = `${service}:${key}`;
    const prior = this.state.idempotency.get(k);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return {
          status: 400,
          body: { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } },
          replayed: true,
        };
      }
      return { status: prior.status, body: prior.body, replayed: true };
    }
    const result = run();
    if (result.status < 500) this.state.idempotency.set(k, { fingerprint, ...result });
    return { ...result, replayed: false };
  }
}
