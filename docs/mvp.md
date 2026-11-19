# undo — MVP spec

## Premise

From Berny, 2026-11-18:

> AI agents now take real actions, like purchases, refunds and emails, and when they get it wrong there's no undo button. Undo records everything an agent does, so you can reverse any mistake in one click or one sentence.

Decisions from Berny, 2026-11-18:

- Open source, named undo, built only on Vercel products and infra.
- No "zero tokens" promise: unrealistic for agentic work.
- Agents run unattended. Nothing waits for a person unless the developer asks for it on that tool; otherwise another agent checks.
- Use Vercel's products, its connectors (Vercel Connect) and eve as much as possible.

Sources: Vercel's saga pattern guide (https://vercel.com/i/saga-pattern); eve 1.0.2 bundled docs (`node_modules/eve/docs/`: extensions, tools/human-in-the-loop, tools/workflows, tools/tasks, guides/hooks, guides/decide, connections); the Vercel Connect skill (`@vercel/connect`, `@vercel/connect/eve`). eve 1.1.0 is out; re-read the installed docs before building. Vercel Connect catalog and team state checked 2026-11-18 with the Vercel MCP (`list_connectors`, docs search) and Vercel CLI 65.12.1 (`vercel connect discover`).

## The promise, as testable rules

| Promise | Rule |
|---|---|
| Records everything an agent does | Every call the agent makes (its own tools, extension tools, connection tools, subagents) lands in the ledger: input, result, time, session, and how to reverse it. |
| Reverse any mistake | Every action is cancellable, reversible, or labelled `irreversible` before it runs, never after. |
| Agents stay unattended | No call waits for a person unless its tool says `approve: "human"`. |
| In one click | Every ledger row has an Undo button. |
| In one sentence | "Undo the refund to Alice", from a person or another agent, finds the rows and reverses them. |

## Shape: undo is an eve extension

undo ships as an eve extension package. `@undo` on npm belongs to another user (checked 2026-11-19), so the working name is `undo-eve` (free on npm today); Berny picks the published name. An agent installs it and adds two files:

```ts
// agent/extensions/undo.ts
import undo from "undo-eve";
export default undo({ hold: "2m", defaultApprove: "agent", slack: "slack/undo" });
```

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { undoPolicy } from "undo-eve";
export default defineAgent({ model: "anthropic/claude-sonnet-5-5", approval: undoPolicy() });
```

The second file is needed because an extension can't set agent-wide config; eve's agent-wide `approval` policy is what lets undo see and gate every call, including connection tools and subagents.

### What each eve and Vercel piece does

| undo needs | eve / Vercel piece |
|---|---|
| Record every call | Extension hook (`hooks/ledger.ts`) on `call.started` / `call.settled`; `call(ctx.view, callId)` gives name, input, output, state |
| Decide before a call runs | Agent-wide `approval` policy (`undoPolicy`): returns `approved`, `{ type: "denied", reason }` or `user-approval` |
| Classify unknown tools | MCP `toolAnnotations` (`readOnlyHint`, `destructiveHint`) passed to the policy |
| Quick checks in the policy | A `check` function. Default: `decide` from `eve/ai` (AI Gateway, `typesafe-ai/jev`). Tests and the demo pass a scripted check, so they make no model calls. |
| Hold an action, reply at once | The adapter is an `execute` workflow tool. It runs the review (when required), then starts a separate hold run with `start()` from a step and returns `{ status: "scheduled", rowId, undoUntil }`. The hold run sleeps (no compute) until `undoUntil`, a release, or a cancel. The turn doesn't wait for the hold, so a 2-minute hold doesn't keep the agent's turn open (eve holds a turn open while any `task()` works). |
| Reviewer before the hold | `ctx.agent("undo__reviewer").send(..., { outputSchema })` from the adapter's workflow body; `ctx.agent()` itself is not gated by the approval policy |
| Reviewer and undo agents | Extension subagents: `undo__reviewer`, `undo__undoer` |
| The agent undoing its own mistake | Extension tools: `undo__undo`, `undo__history` |
| Sentence undo and human approvals in Slack | eve Slack channel with `connectSlackCredentials("slack/undo")` from `@vercel/connect/eve`; eve renders approval cards with Approve / Deny |
| Stripe, Resend and other services | eve connections (MCP or OpenAPI) with `connect("<connector>")` from Vercel Connect; tokens, refresh and consent handled by Connect. Stripe: `mcp`, `api-key`. Resend: `oauth`, `mcp`, `api-key`. |
| Know when an action became final | Connect trigger forwarding: Resend supports it (e.g. a delivered email turns its row `irreversible`). Stripe doesn't through Connect; undo reads Stripe state in the inverse instead. |
| Keys for services Connect doesn't list | Vercel Marketplace integrations, read as env vars (not needed for the MVP) |
| Ledger store | A `LedgerStore` interface. The MVP ships a local SQLite file (`node:sqlite`, `.undo/ledger.db`). Held actions are also Workflow runs (hold, release and cancel hooks). A hosted store on Vercel (Marketplace Postgres or Redis) comes after the MVP and needs Berny's pick, since it can cost money. |
| Daily digest | Extension schedule `undo__digest`: what became final, what's still undoable, conflicts |
| Ledger UI | Next.js with `withEve`, the eve client SDK for live sessions |
| Tests | eve evals with tool stubs |
| Traces | Vercel Agent Runs (`vercel agent-runs`), Observability |
| Deploy | `eve deploy` to Vercel |

## How an action can be undone

| Strategy | When | How in eve | Example |
|---|---|---|---|
| **Cancel** | Before the effect happens | An undo adapter returns `{ status: "scheduled", rowId, undoUntil }` and holds the effect in its own Workflow run (default 2 min), then runs it. Undo in the hold = it never happened. A reviewer approval releases it early. | Resend email; Stripe refund |
| **Reverse** | After it happened, an inverse exists | The inverse runs as a durable step with an idempotency key, compare-and-restore (a newer write by someone else is a conflict, never overwritten). | Stripe: cancel an authorization, refund a capture |
| **None** | No inverse exists | It runs and the row is `irreversible`. Undo can offer a follow-up (a correction email), never pretend. | A connection tool with no adapter; a refund after its hold |

## Who approves

Approval is separate from the strategy. `undoPolicy` decides for every call:

| Call | Default |
|---|---|
| `readOnlyHint: true`, or a known read tool | runs, recorded |
| undo adapter (has a hold) | runs; the adapter asks the reviewer first when its approve is `agent` |
| connection tool with no adapter, or `destructiveHint: true` | `approve: "agent"`: a quick `decide` check against the session and ledger; denied calls get the reason back |
| any tool the developer set to `approve: "human"` | `user-approval`: eve pauses the call; Approve / Deny in Slack or the ledger UI |

Per tool, `approve` is `"none" | "agent" | "human"` or a rule: `({ cents }) => cents > 50_000 ? "human" : "agent"`.

## MVP features

### 1. Record everything

The `ledger` hook writes every settled call. A direct connection call (say, Stripe's MCP `create_refund`) is recorded even though undo didn't wrap it.

### 2. Adapters

Adapters are undo's own workflow tools, with hold, inverse and default approve. They get credentials from Vercel Connect (`getToken`), using the same connector as the agent's connection.

| Adapter tool | Strategy | Default approve |
|---|---|---|
| `undo__stripe_authorize` | reverse: cancel authorization | none |
| `undo__stripe_capture` | reverse: refund | agent |
| `undo__stripe_refund` | cancel during hold, then none | agent |
| `undo__resend_send` | cancel during hold (scheduled send), then none | none |

When an adapter exists for a connection's write tool, `undoPolicy` denies the direct call with the reason "use `undo__stripe_refund`", so the agent switches to the undoable version on its own.

Adapters are keyed by Vercel Connect service name (`stripe`, `resend`), so the adapter catalog grows one Connect service at a time and is where outside contributors add the most. Connect lists 70 services under `commerce` alone, among them PayPal, Shopify, Shop ("approve purchases with saved cards"), Agentcard ("issue virtual cards for AI agents and place orders they pay for") and Skyfire ("payments ... for AI agents"). Any of them is recorded from day one; an adapter adds holds and inverses.

### 3. `reversible()` for your own tools

```ts
// agent/tools/issue_credit.ts
import { reversible } from "undo-eve";

export default reversible({
  description: "Give a customer store credit.",
  strategy: "reverse",            // "cancel" | "reverse" | "none"
  approve: "agent",
  inputSchema: z.object({ customer: z.string(), cents: z.number() }),
  do: async (input, ctx) => credits.add(input, { idempotencyKey: ctx.stepId }),
  undo: async (input, result, ctx) => {
    const now = await credits.get(input.customer);
    if (now.lastChange !== result.changeId) return ctx.conflict(now);
    await credits.remove(result.changeId, { idempotencyKey: ctx.stepId });
  },
});
```

It compiles to an eve workflow tool, so `do` and `undo` are durable steps.

### 4. The reviewer (`undo__reviewer` subagent)

- Read-only: the ledger, the session's messages (e.g. the ticket), and read tools from the agent's connections (the Stripe customer and order).
- Called by each adapter whose approve is `agent`, with `ctx.agent("undo__reviewer")`, before the hold starts. Approve releases the action at once; block means it never runs, and the acting agent gets `{ status: "blocked", reason }` as the tool result and replans.
- Verdict and reason are stored on the ledger row. It can use a different model from the acting agent.

### 5. The undoer (`undo__undoer` subagent) and `undo__undo`

- `undo__undoer`: takes a sentence ("undo everything the support agent did for Alice today"), searches the ledger, returns a plan (rows, strategy, what can't be reversed), and runs it. From a person it asks for one confirm; from another agent it runs when that agent may undo.
- `undo__undo` / `undo__history`: tools the acting agent itself uses to fix its own mistake mid-run ("I refunded the wrong order, undo it").

### 6. Slack, through Vercel Connect

- The undo Slack channel: type "undo the refund to Alice" in a thread or DM.
- Human approvals (only tools set to `"human"`) arrive as eve's approval cards.
- The daily digest posts there.

### 7. Ledger UI

Next.js page (a plain local page in the MVP): everything every agent did, with state (`held`, `in review`, `blocked`, `done`, `undone`, `conflict`, `irreversible`), the reviewer's verdict, a countdown on held rows, and **Undo**, **Undo run**, **Undo to here**. Live through the eve client SDK.

### 8. Demo: a shop's support agent

An eve agent with Stripe and Resend, both through Vercel Connect, test mode. No person until step 3.

1. Alice's ticket says "refund my order". The agent refunds Bob's order and emails Bob.
2. The refund is held; the reviewer compares it with the ticket and blocks it ("customer doesn't match the ticket"). The agent replans, refunds Alice, the reviewer releases it early.
3. The email to Bob is still held. Someone types "cancel the email to Bob" in Slack: it is never delivered.
4. The ledger shows all of it, with the reviewer's reasons.

## How agentic it gets

| Level | What | In MVP |
|---|---|---|
| 1. Safety net | Every call recorded; held or reversible; one-click undo | yes |
| 2. Reviewer | An agent approves or blocks held actions | yes |
| 3. Self-correction | The acting agent undoes its own mistakes with `undo__undo` | yes |
| 4. Undoer | One sentence from a person or an agent unwinds the right rows | yes |
| 5. Writes inverses | Proposes an `undo` for a connection tool with no adapter; the reviewer or a person accepts it | later |

## Out of scope for the MVP

- `withUndo()` for plain AI SDK agents (not eve).
- An MCP proxy for agents on other frameworks.
- Adapters beyond Stripe and Resend. Next for purchases: Agentcard or Shop.
- Multi-tenant hosting.
- Undo of a message a person already read.

## Setup (needs a person, in a browser)

The web-shinobi team has no Connect connectors yet. Run from the demo agent's folder, so Connect wires the project:

```bash
vercel connect create stripe --connection-method mcp --name undo-stripe
vercel connect create resend --connection-method mcp --name undo-resend --triggers
vercel connect create slack --name undo
```

## Checked before building (2026-11-19, eve 1.1.0 docs)

- **eve 1.1.0 changes** (released 2026-11-18): `defineModel` with connection-style auth, `ctx.waitUntil` in channel handlers, `eve dev --no-ui` prints `[DEV] ready at <url>`, idle sandboxes stop after 5 minutes, and the local Workflow world moved to one SQLite file (`.eve/.workflow-data/world.db`). None changes extensions, hooks, approval policies or workflow tools.
- **Extensions can't set agent config.** Confirmed: the extension root can't declare agent configuration, so `approval: undoPolicy()` in `agent.ts` stays.
- **The agent-wide policy gates every call**, including extension, workflow, connection and local subagent calls, and gets `toolAnnotations` for connection tools. It is async, so it reads the ledger store directly; it doesn't need extension state. Not gated: `ctx.agent()` in workflow code, task controls, `ask_question`, sign-ins.
- **Hooks don't see subagent turns.** A parent `call.settled` hook records the call to the subagent, not the subagent's own calls. A subagent's own calls are recorded when that subagent mounts undo too (`subagents/<id>/extensions/undo.ts`). undo's own reviewer and undoer are read-only and need no ledger of their own.
- **Steps can't read or write `defineState`.** The ledger therefore lives in undo's store, not in eve state.
- **`task()` holds the turn open** until the task ends, which is why holds run in their own Workflow run (see the mapping table).
- **Scripted models**: `mockModel` from `eve/evals` scripts replies and tool calls, so the demo and evals run with no model provider.
- **Stripe**: a refund can't be cancelled once Stripe accepts it (only a refund in `requires_action` can be), so `undo__stripe_refund` holds before it calls Stripe. A manual-capture PaymentIntent can be cancelled before capture. Stripe takes `Idempotency-Key` on every POST.
- **Resend**: an email sent with `scheduled_at` can be cancelled until it is sent (`POST /emails/{id}/cancel`); after that it can't.
- **Not checked yet**: which Stripe and Resend MCP tools carry `readOnlyHint` / `destructiveHint`. That needs a real connection. Until then the policy falls back to a list of known write tool names per service.

## Local MVP (what Berny tests first)

The first build runs on one machine, spends nothing and needs no accounts:

- **Fakes** for Stripe, Resend and Slack in one local server, with test-mode behavior: idempotency keys, a scheduled email that can be cancelled until it sends, a refund that can't be undone once it's final, and a capture that can be refunded.
- **Scripted models** (`mockModel`) for the support agent, the reviewer and the undoer. No AI Gateway calls.
- **One command** runs the demo end to end and prints the ledger.
- **The ledger UI** runs locally with an Undo button on every row.
- Swapping the fakes for Vercel Connect connections, and the scripted models for real ones, is a config change described in the README; it needs Berny's go-ahead because it can spend money.

## Done looks like

1. The demo runs with no person until step 3: locally on fakes in the MVP, on Vercel once Berny approves connectors and a deploy.
2. Adding undo to an eve agent is `pnpm add undo-eve` plus the two files above.
3. With default settings, no call waits for a person.
4. A direct Stripe MCP write is recorded; with an adapter, it is redirected to the adapter.
5. The reviewer blocks the wrong-customer refund in an eve eval and in the live demo; Stripe never sees it.
6. Undo during a hold: no refund in Stripe, the email cancelled in Resend.
7. Undo after a capture: one refund in Stripe, even if undo runs twice.
8. "undo the refund to Alice" in Slack reverses exactly that row; a vague sentence gets a question.
9. A hand edit made after the agent shows as a conflict on undo and is kept.
