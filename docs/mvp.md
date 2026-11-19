# undo — MVP spec

## Premise

From Berny, 2026-11-18:

> AI agents now take real actions, like purchases, refunds and emails, and when they get it wrong there's no undo button. Undo records everything an agent does, so you can reverse any mistake in one click or one sentence.

Decisions from Berny, 2026-11-18:

- Open source, named undo, built on Vercel products and infra.
- No "zero tokens" promise: unrealistic for agentic work.
- Agents run unattended. Nothing waits for a person unless the developer asks for it on that tool; otherwise another agent checks.
- Use Vercel's products, its connectors (Vercel Connect) and eve as much as possible.

Sources: Vercel's saga pattern guide (https://vercel.com/i/saga-pattern); the eve 1.1.0 bundled docs (`node_modules/eve/docs/`); the Vercel Connect skill (`@vercel/connect`, `@vercel/connect/eve`). Every eve claim below was checked against eve 1.1.0, most of them in a local spike (see [Checked before building](#checked-before-building-2026-11-19)).

## The promise, as testable rules

| Promise | Rule |
|---|---|
| Records everything an agent does | Every call the root agent makes (its own tools, extension tools, connection tools, calls to subagents) gets a ledger row: input, result, time, session, state, and how to reverse it. A subagent's own calls get rows when that subagent mounts undo too. |
| Reverse any mistake | Every row gets its strategy (`cancel`, `reverse` or `none`) before the call runs, never after. `none` rows are labelled `irreversible`. |
| Agents stay unattended | No call waits for a person unless the developer set `approve: "human"` for it. |
| In one click | Every row that can still be undone has an Undo button. |
| In one sentence | "cancel the email to Bob", from a person or from the agent itself, finds the rows and reverses them; a vague sentence gets a question back. |

## Shape: an eve extension plus a policy

undo ships as one npm package with an eve extension inside. `@undo` on npm belongs to another user (checked 2026-11-19), so the working name is `undo-eve`; Berny picks the published name. A developer runs `pnpm add undo-eve` and adds two files. The mount file must be named `undo.ts`, because the filename sets the `undo__` prefix:

```ts
// agent/extensions/undo.ts
import { undo } from "undo-eve/agent";

export default undo({
  hold: "2m",                                // how long cancel-strategy actions wait
  adapters: { stripe: "stripe", resend: "resend" }, // service -> the agent's connection name
  approve: { stripe__create_coupon: "human" }, // per-tool overrides; default comes from defaultApprove
  defaultApprove: "agent",
});
```

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { undoPolicy } from "undo-eve/agent";

export default defineAgent({
  model: "anthropic/claude-sonnet-5-5",
  approval: undoPolicy(), // or undoPolicy(yourExistingPolicy); the stricter answer wins
});
```

The second file is needed because an extension can't set agent-wide config, and eve's agent-wide `approval` policy is the only place that sees every call before it runs, including connection tools and subagent calls. `undo()` keeps the config for `undoPolicy()` in the same process.

Every option in one place:

| Option | Default | What it does |
|---|---|---|
| `hold` | `"2m"` | How long a `cancel` action waits before it runs. |
| `defaultApprove` | `"agent"` | Approval for writes that have no per-tool setting: `"none"`, `"agent"` or `"human"`. |
| `approve` | `{}` | Per-tool approval by final tool name, or a rule: `({ input }) => input.amount > 50_000 ? "human" : "agent"`. |
| `adapters` | `{}` | Which connection each adapter service uses, e.g. `{ stripe: "stripe" }`. |
| `services` | Vercel Connect | How adapters reach each service: `{ stripe: { baseUrl, token } }`. The demo points these at the local fakes. |
| `review` | `decide` from `eve/ai` (AI Gateway) | The reviewer: `(call, context) => { verdict, reason }`. The demo passes a scripted one. |
| `match` | `decide`-based | Turns a sentence into ledger rows. The demo passes a scripted one. |
| `store` | SQLite at `.undo/ledger.db` | Where the ledger lives. |

## How a call flows

```
model calls a tool
  └─ undoPolicy(call)                 writes the row (state: requested, strategy set)
       ├─ read tool                    → runs
       ├─ write with an adapter         → denied: "use undo__stripe_refund; it can be undone for 2m"
       ├─ approve "none"                → runs
       ├─ approve "agent"               → reviewer → runs, or denied: "blocked by reviewer: <reason>"
       └─ approve "human"               → eve pauses the call for a person
  └─ the tool runs
       ├─ cancel strategy (adapter)     → row held until undoUntil → runs → done (or failed)
       ├─ reverse strategy              → runs now → done; the inverse is ready
       └─ none                          → runs now → irreversible
  └─ ledger hook (call.settled)        fills in the result and final state
```

Approval and strategy are separate. Approval decides whether the call runs at all. The strategy decides how it can be undone. The review happens before the hold, and the hold always runs its full length: a reviewer's approval never shortens it.

## What each eve and Vercel piece does

| undo needs | eve / Vercel piece |
|---|---|
| Write the row and decide before a call runs | Agent-wide `approval` policy (`undoPolicy`). It gets `toolName`, `toolInput`, `callId`, `session` and, for MCP tools, `toolAnnotations`. It runs for local subagent calls too. |
| Fill in results | Extension hook on `call.settled`, using `call(ctx.view, callId)` |
| The ticket and other context for the reviewer | The same hook records each user message from `delivery.consumed` against its session |
| Reviewer | `review` function called from `undoPolicy`; default is `decide` from `eve/ai` (AI Gateway, `typesafe-ai/jev`) with the call, the session's messages and its recent rows |
| Adapters | Extension tools (`undo__stripe_refund`, `undo__stripe_capture`, `undo__resend_send`) |
| Hold an action | The row's own state machine in the ledger: `held` until `undoUntil`, then a compare-and-set to `running`. An in-process timer runs it on time; an extension schedule (`undo__sweep`, every minute) runs anything the timer missed, such as after a restart. Resend holds natively: undo sends with `scheduled_at` and cancels through Resend. |
| The agent fixing its own mistake | Extension tools `undo__undo` and `undo__history`, plus a short extension `instructions.md` |
| One click, one sentence | Extension channel routes: the ledger page at `GET /undo`, a JSON API under `/undo/api`, and a sentence box on the page |
| Stripe and Resend in production | eve MCP connections with `connect("<connector>")` from `@vercel/connect/eve`; adapters get tokens with `getToken` from `@vercel/connect` |
| Ledger store | `LedgerStore` interface; the MVP ships SQLite (`node:sqlite`). A hosted store on Vercel comes after the MVP and needs Berny's pick, because it can cost money. |
| Tests | Vitest for the core, plus one eve eval of the demo with `mockModel` |
| Traces | eve's own traces locally; Vercel Agent Runs once deployed |

eve 1.1.0 refuses Workflow directives (`"use workflow"`, `"use step"`) in extension code, so undo can't ship workflow tools. Holds therefore live in the ledger's state machine, not in Workflow runs. If eve later allows workflow tools in extensions, holds can move to `sleep` plus a cancel hook without changing the agent contract.

## How an action can be undone

| Strategy | When | How | Example |
|---|---|---|---|
| **Cancel** | Before the effect happens | The adapter returns `{ status: "scheduled", rowId, undoUntil }` at once and holds the effect for `hold`. Undo in the hold means it never happens. | Stripe refund, Resend email |
| **Reverse** | After it happened, an inverse exists | The inverse runs with an idempotency key derived from the row, so running undo twice reverses once. It checks the current state first: a newer change by someone else is a `conflict`, never overwritten. | Stripe capture (inverse: refund), your own `reversible()` tools |
| **None** | No inverse exists | It runs and the row is `irreversible`. Undo says so and never pretends. | A connection write with no adapter; a refund after its hold |

## The agent contract

What the acting agent sees. Each adapter's description ends with its undo terms, such as "Held 2 minutes, then final."

| Tool | Input | Results |
|---|---|---|
| `undo__stripe_refund` | `{ payment_intent, amount?, reason? }` | `{ status: "scheduled", rowId, undoUntil }` |
| `undo__stripe_capture` | `{ payment_intent, amount? }` | `{ status: "done", rowId, undo: "refund" }` |
| `undo__resend_send` | `{ to, subject, text }` | `{ status: "scheduled", rowId, undoUntil }` |
| Any write the policy denies | | eve's denied result with the reason: `use undo__stripe_refund; it can be undone for 2m`, `blocked by reviewer: <reason>`, or `review unavailable, try again` |
| `undo__history` | `{ query?, limit? }` (default: this session, 20 rows) | One line per row: `<rowId> <tool> <summary> <state> [undo until <time>]` |
| `undo__undo` | `{ rowId }` or `{ request }` | `{ status: "cancelled" \| "undone", rowId }`, `{ status: "conflict", current }`, `{ status: "irreversible", rowId, followUp }`, `{ status: "ambiguous", candidates }`, `{ status: "not_found" }`, `{ status: "not_allowed", reason }` |

Rules:

- `undo__undo` needs no approval for rows from the agent's own session. For other rows it returns `not_allowed`; a person undoes those from the ledger page.
- A held action that later fails at the service gets state `failed`, which `undo__history` shows.
- The extension's `instructions.md` adds about 120 tokens: say "scheduled" until the state is `done`; check `undo__history` before telling anyone an action happened; use `undo__undo` to fix your own mistakes.

Row states: `requested`, `blocked`, `awaiting_person`, `held`, `running`, `done`, `failed`, `cancelled`, `undone`, `conflict`, `irreversible`.

## MVP features

### 1. Record everything

`undoPolicy` writes a row for every call, keyed by `callId`, before the call runs; the hook fills in the result. A direct connection call, such as a fake Stripe MCP `create_coupon` with no adapter, is recorded even though undo didn't wrap it. A subagent's own calls get rows from the policy, but their results stay empty unless that subagent mounts undo too; undo logs a warning at startup for each subagent without the mount.

### 2. Adapters

Adapters are undo's own tools, with strategy, hold and default approve. They are keyed by Vercel Connect service name, so the catalog grows one Connect service at a time; this is where outside contributors add the most.

| Adapter tool | Strategy | Default approve |
|---|---|---|
| `undo__stripe_refund` | cancel during hold, then none | agent |
| `undo__stripe_capture` | reverse: refund | agent |
| `undo__resend_send` | cancel during hold (Resend `scheduled_at`), then none | none |

When an adapter exists for a connection's write tool (`stripe__create_refund`, `resend__send_email`), `undoPolicy` denies the direct call with the reason "use `undo__stripe_refund`", so the agent switches to the undoable version on its own. Each adapter lists the connection tool names it covers.

### 3. `reversible()` for your own tools

```ts
// agent/tools/issue_credit.ts
import { reversible } from "undo-eve/agent";
import { z } from "zod";
import { credits } from "../lib/credits";

export default reversible({
  description: "Give a customer store credit.",
  approve: "agent",
  inputSchema: z.object({ customer: z.string(), cents: z.number() }),
  do: async (input, ctx) => credits.add(input, { idempotencyKey: ctx.idempotencyKey }),
  undo: async (input, result, ctx) => {
    const now = await credits.get(input.customer);
    if (now.lastChange !== result.changeId) return ctx.conflict(now);
    await credits.remove(result.changeId, { idempotencyKey: ctx.idempotencyKey });
  },
});
```

`reversible()` returns an ordinary eve `defineTool` with strategy `reverse`. `ctx.idempotencyKey` is derived from the row, so a retried `do` or a second `undo` repeats the same key. At load, undo registers `undo` in a process-wide registry under the tool's description (or an explicit `id`), and the row stores that key, so the Undo button, `undo__undo` and the sentence box all find it later. `undo` is not a durable Workflow step (see above); the row's state machine plus the idempotency key make a retry safe.

### 4. The reviewer

- Runs inside `undoPolicy` for every call whose approve is `agent`, before the call starts and before any hold.
- Sees the call, the session's user messages (such as the ticket) and the session's recent rows. Read-only.
- Approve: the call runs (and holds, for a cancel adapter). Block: the call never runs, and the acting agent gets "blocked by reviewer: <reason>" and replans. Verdict and reason are stored on the row.
- If the review errors or times out, the call is denied with "review unavailable, try again". It never falls back to asking a person.
- It can use a different model from the acting agent.

### 5. Undo in one sentence

`planUndo(sentence, scope)` uses `match` to turn a sentence into rows. One clear match: undo it. Several or none: return the candidates as a question. Two entry points:

- **The ledger page's sentence box** (a person): shows the plan; the person confirms with one click.
- **`undo__undo({ request })`** (the acting agent): runs on its own session's rows without a confirm.

### 6. Ledger page

One page served by the extension at `/undo` on the agent's own server. It polls `/undo/api/rows` every second and shows every row: tool, summary, state, reviewer verdict and reason, a countdown on held rows, a link to its eve session, and an **Undo** button on each row that can still be undone. The sentence box sits on top.

### 7. Demo: a shop's support agent

An eve agent with Stripe and Resend. In the local MVP both are fakes and every model is scripted. No person until step 3.

1. Alice's ticket says "refund my order". The agent tries `stripe__create_refund` for Bob's order; undo denies it ("use `undo__stripe_refund`"). It calls `undo__stripe_refund` for Bob.
2. The reviewer compares it with the ticket and blocks it ("customer doesn't match the ticket"). The agent replans and calls `undo__stripe_refund` for Alice; the reviewer approves; the refund holds for the demo hold. Meanwhile the agent emails Bob by mistake with `undo__resend_send`; it holds too.
3. Someone types "cancel the email to Bob" in the ledger page's sentence box and confirms: the email is cancelled and never sent.
4. Alice's refund runs when its hold ends. The ledger shows every call with the reviewer's reasons: one refund to Alice in the fake Stripe, no refund to Bob, no email to Bob.

## Local MVP (what Berny tests first)

The first build runs on one machine, spends nothing and needs no accounts:

- **Fakes** for Stripe and Resend in one local server with a request log: idempotency keys, a scheduled email that can be cancelled until it sends, a refund that can't be undone once it's final, a capture that can be refunded. Fake Stripe also serves a small MCP endpoint (`retrieve_customer`, `create_refund`, `create_coupon`) mounted as the demo's `stripe` connection.
- **Scripted models**: the support agent uses eve's `mockModel`; `review` and `match` are scripted functions. No AI Gateway calls. The scripted reviewer proves the wiring, not the judgement.
- **One command** (`pnpm demo`) starts the fakes and the agent, runs steps 1 to 4, and prints the ledger. A short hold (`20s`) keeps it quick.
- **The ledger page** runs locally with an Undo button on every row.
- Swapping fakes for Vercel Connect and scripted functions for real models changes the `services`, `review` and `match` options and two connection files. The README shows the exact lines. It needs Berny's go-ahead, because it can spend money.

## Not in the MVP

- Slack: sentence undo and human approvals in Slack through Vercel Connect, the daily digest. The ledger page covers both locally.
- An `undo__undoer` subagent: `planUndo` with `match` covers sentences.
- Resend delivery triggers through Vercel Connect; Stripe authorization adapter.
- "Undo run" and "Undo to here".
- A hosted ledger store, deploys, Agent Runs dashboards.
- Letting `approve: "human"` name who may approve. eve's default applies: only the person whose turn made the call can answer, so `human` fits sessions a person started.
- `withUndo()` for plain AI SDK agents, an MCP proxy for other frameworks, adapters beyond Stripe and Resend, multi-tenant hosting, undo of a message a person already read.

## How agentic it gets

| Level | What | In MVP |
|---|---|---|
| 1. Safety net | Every call recorded; held or reversible; one-click undo | yes |
| 2. Reviewer | An agent approves or blocks writes before they run | yes |
| 3. Self-correction | The acting agent undoes its own mistakes with `undo__undo` | yes |
| 4. Sentence undo | One sentence from a person or the agent unwinds the right rows | yes |
| 5. Writes inverses | Proposes an `undo` for a connection tool with no adapter | later |

## Setup with real services (after the MVP; needs a person, in a browser)

The web-shinobi team has no Connect connectors yet. Run from the demo agent's folder, so Connect wires the project:

```bash
vercel connect create stripe --connection-method mcp --name undo-stripe
vercel connect create resend --connection-method mcp --name undo-resend
```

## Checked before building (2026-11-19)

From the eve 1.1.0 docs and a local spike with `eve dev` and `mockModel`:

- **eve 1.1.0 changes** (released 2026-11-18): `defineModel` with connection-style auth, `ctx.waitUntil` in channel handlers, `eve dev --no-ui` prints `[DEV] ready at <url>`, idle sandboxes stop after 5 minutes, the local Workflow world moved to one SQLite file. None affects undo.
- **Extensions can't use Workflow directives** (spike: `eve extension build` fails with "Workflow directives are supported in application modules only"). Re-exporting a workflow tool from a package fails too. Hence the ledger state machine for holds.
- **Extensions can't set agent config**, so `approval: undoPolicy()` stays in `agent.ts`. The extension handle's config can't be read from `agent.ts` (spike: "Invalid extension config"), so `undo()` keeps it for `undoPolicy()` (spike: works). Functions in extension config work.
- **The agent-wide policy** sees every call with `toolName`, `toolInput`, `callId` (spike: yes, including extension tools) and is async, so it can read and write the store. Not gated: `ctx.agent()` in workflow code, task controls, `ask_question`, sign-ins.
- **Hooks don't see subagent turns**; the root policy does see local subagent calls.
- **A registry filled by an app tool module is visible to extension routes** in the same process (spike: yes).
- **Extension routes** serve the ledger page and API (spike: a route on the agent's server works).
- **`mockModel`** scripts replies and tool calls (spike: yes). Structured output from a scripted model goes through `eve__reply`.
- **Stripe**: a refund can't be cancelled once Stripe accepts it (only a refund in `requires_action` can be), so `undo__stripe_refund` holds before it calls Stripe. Stripe takes `Idempotency-Key` on every POST.
- **Resend**: an email sent with `scheduled_at` can be cancelled until it sends (`POST /emails/{id}/cancel`).
- **Not checked yet** (needs real connections): which Stripe and Resend MCP tools carry `readOnlyHint` / `destructiveHint`, and `getToken` from an adapter on Vercel. Until then the policy uses each adapter's list of covered write tools plus a read-name heuristic.

## Done looks like

Each item is checked locally against the fakes; the same checks run against Vercel once Berny approves connectors and a deploy.

1. `pnpm demo` runs the demo with no person until step 3 and exits 0.
2. Adding undo to an eve agent is `pnpm add undo-eve` plus the two files above.
3. With default settings, no call waits for a person (a test runs a session with every default and finds no `awaiting_person` row).
4. A direct fake Stripe MCP write with no adapter is recorded; one with an adapter is denied with the adapter's name, and the agent then uses the adapter.
5. The reviewer blocks the wrong-customer refund in an eve eval and in the demo; the fake Stripe request log shows no refund to Bob.
6. Undo during a hold: no refund in the fake Stripe log; the email is cancelled in the fake Resend and never sends.
7. Undo after a capture: exactly one refund in the fake Stripe log, even when undo runs twice.
8. "cancel the email to Bob" undoes exactly that row; "undo it" gets a question with candidates.
9. A change made by someone else after the agent's `reversible()` write shows as `conflict` on undo, and the newer change is kept.
