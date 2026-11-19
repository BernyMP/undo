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
| Records everything an agent does | Every call eve reports to undo's policy or hook (the agent's own tools, extension tools, connection tools, calls to subagents, eve's built-ins) gets a ledger row: input, result, time, session, state, and how to reverse it. A subagent's own calls get rows when that subagent mounts undo too. |
| Reverse any mistake | Every write gets its strategy (`cancel`, `reverse` or `none`) before the call runs, never after. A write with strategy `none` is labelled `irreversible`. |
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
  approve: { stripe__create_coupon: ({ input }) => (input.percent_off > 50 ? "human" : "agent") },
  defaultApprove: "agent",
});
```

```ts
// agent/agent.ts
import { defineAgent } from "eve";
import { undoPolicy } from "undo-eve/agent";

export default defineAgent({
  model: "anthropic/claude-sonnet-5.5",
  approval: undoPolicy(), // or undoPolicy(yourExistingPolicy); the stricter answer wins
});
```

The second file is needed because an extension can't set agent-wide config, and eve's agent-wide `approval` policy is the only place that sees every call before it runs, including connection tools and subagent calls. `undo()` keeps the config for `undoPolicy()` in the same process.

Every option in one place:

| Option | Default | What it does |
|---|---|---|
| `hold` | `"2m"` | How long a `cancel` action waits before it runs. |
| `defaultApprove` | `"agent"` | Approval for writes that have no per-tool setting: `"none"`, `"agent"` or `"human"`. |
| `approve` | `{}` | Per-tool approval by final tool name. Each value is an approve or a rule, e.g. `{ issue_credit: ({ input }) => input.cents > 50_000 ? "human" : "agent" }`. Wins over a tool's own `approve` and an adapter's default. |
| `reads` | `[]` | Extra tool names to treat as reads (no review, nothing to undo). |
| `subagents` | `[]` | Names of your declared subagents. eve's policy can't tell a subagent call from a tool call, so list them here to record them without review. |
| `adapters` | `{}` | Which connection each adapter service uses, e.g. `{ stripe: "stripe" }`. |
| `services` | Vercel Connect | How adapters reach each service: `{ stripe: { baseUrl, token } }`. The demo points these at the local fakes. |
| `review` | `decide` from `eve/ai` (AI Gateway) | The reviewer: `(call, context) => { verdict, reason }`. The demo passes a scripted one. The default asks `decide` one `choice` question with fixed criteria (`approve`, `wrong_customer`, `wrong_amount`, `not_requested`, `other`); the chosen criterion's text becomes the reason. |
| `match` | `decide`-based | Turns a sentence into ledger rows. The demo passes `keywordMatch` (no model). The default is one `decide` `choice` over the candidate row ids plus `none` and `several`. |
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

`undoPolicy` sorts each call by the first rule that matches:

1. undo's own tools: `undo__history` and `undo__undo` run with no review; adapters use their own strategy, and approve from the `approve` option, else the adapter's default.
2. A connection write that an adapter covers (such as `stripe__create_refund`): denied with the adapter's name, plus "If you don't have undo__stripe_refund, this write isn't allowed here", so a subagent without undo doesn't loop. Key `approve` by the adapter's name (`undo__stripe_refund`); undo logs once if `approve` names a covered tool.
3. Reads: MCP tools with `readOnlyHint: true`, the read tools each adapter lists for its service (such as `stripe__retrieve_customer`), eve's `read_file`, `glob`, `grep`, `web_search`, `web_fetch`, `eve__search`, `eve__skill` and task controls, and anything in `reads`. They run with no review; the row records them.
4. `reversible()` tools: strategy `reverse`, approve from the `approve` option, else the tool's own, else `defaultApprove`.
5. eve's sandbox tools (`bash`, `write_file`, `edit_file`), eve's built-in `agent` tool and subagents listed in `subagents`: recorded, not reviewed. eve's default sandbox can reach the network, so if `bash` can reach outside services, set the sandbox's `networkPolicy: "deny-all"` or put `bash` in `approve`.
6. Everything else, including connection writes with no adapter and your plain tools: strategy `none` (labelled `irreversible`) and approve from the `approve` option, else `defaultApprove`.

There is no name-guessing: a connection tool with no annotation that no adapter lists is treated as a write until you add it to `reads`. So is a plain tool of yours: the first time undo reviews one of your tools as a write, it logs one line naming it ("add read-only tools to `reads`").

End states: rows from rules 3 and 5 carry no strategy and end `done` with no Undo button; only rule 6 rows end `irreversible`. A redirected call (rule 2) ends `blocked` with its reason, and so does a call a person denies or whose approval is withdrawn. A call cleared but never started by the time its turn ends becomes `blocked` ("never ran"). The hook never overwrites `held`; the executor sets a held row's final state. eve doesn't send some calls to the policy (`eve__` built-ins, `sleep`, `no_reply`, `ask_question`, provider-run tools), so the hook writes their rows after the fact and ends them `done`. If a call reaches the hook with no row and the policy has never run in this process, undo logs "undoPolicy is not set in agent.ts". A subagent that mounts undo calls `undo()` with no options and reuses the root agent's config. If `undo()` never ran, `undoPolicy` denies every call with "mount undo with `undo()` from undo-eve/agent".

Rows are keyed by `session.id` plus `callId`, because eve's `callId` is unique only within a session. eve runs the policy again after a person approves a call; the row is updated, not duplicated, and the reviewer doesn't run again. `approve: "human"` calls never go to the reviewer.

Approval and strategy are separate. Approval decides whether the call runs at all. The strategy decides how it can be undone. The review happens before the hold, and the hold always runs its full length: a reviewer's approval never shortens it.

## What each eve and Vercel piece does

| undo needs | eve / Vercel piece |
|---|---|
| Write the row and decide before a call runs | Agent-wide `approval` policy (`undoPolicy`). It gets `toolName`, `toolInput`, `callId`, `session` and, for MCP tools, `toolAnnotations`. It runs for local subagent calls too. |
| Fill in results | Extension hook on `call.settled`, using `call(ctx.view, callId)` |
| The ticket and other context for the reviewer | The same hook records each user message from `delivery.consumed` against its session |
| Reviewer | `review` function called from `undoPolicy`; default is `decide` from `eve/ai` (AI Gateway, `typesafe-ai/jev`) with the call, the session's messages and its recent rows |
| Adapters | Extension tools (`undo__stripe_refund`, `undo__stripe_capture`, `undo__resend_send`) |
| Fakes for your own tests | The local Stripe and Resend fakes ship as their own package (`undo-fakes`, working name), so developers can point `services` at them in their own evals |
| Hold an action | The row's own state machine in the ledger: `held` until `undoUntil`, then a compare-and-set to `running`. An in-process timer runs it on time. A sweep runs anything the timer missed, such as after a restart. It also re-runs `running` rows older than a 60-second lease with the same idempotency key, so a crash between the compare-and-set and the result can't strand a row. The executor and the first sweep start on undo's first use at runtime (a call, a hook event, a page or API request, or the schedule), never at module load, because eve also loads modules during `eve build`. Once deployed, an extension schedule (`undo__sweep`, every minute) sweeps too; `eve dev` doesn't fire schedules on their cadence, so locally, after a restart, nothing runs due holds until undo is used again (an open ledger page polls, which counts). The compare-and-set means a held action runs once, whoever gets there first. Resend holds natively: undo sends with `scheduled_at`; at `undoUntil` the sweep reads the email's status, and a cancel Resend refuses returns `irreversible`. |
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
| Any write the policy denies | | eve's denied result with the reason: `use undo__stripe_refund; it can be undone for 2m`, `blocked by reviewer: <reason>`, `review unavailable, try once more`, or, after two unavailable reviews of the same tool and input in a session, `review unavailable; don't retry, report it` |
| Your `reversible()` tools | your input | `do`'s result plus `rowId`; the description ends "It can be undone later with undo__undo." |
| `undo__history` | `{ query?, limit? }` (default: this session's last 20 rows that aren't reads or `undo__history` / `undo__undo` calls) | One line per row: `<rowId> <tool> <summary> <state> [undo until <time>]`; `failed` rows come first |
| `undo__undo` | `{ rowId }` or `{ request }` | `{ status: "cancelled" \| "undone", rowId }`, `{ status: "conflict", current }`, `{ status: "irreversible", rowId, followUp }`, `{ status: "ambiguous", candidates }`, `{ status: "not_found" }`, `{ status: "not_allowed", reason }` (also for a row that is `running`, `failed` or never ran) |

Rules:

- `undo__undo` needs no approval for rows from the agent's own session. For other rows it returns `not_allowed`; a person undoes those from the ledger page.
- `current` in a conflict is the service's newer state, as the `undo` function or adapter read it. `followUp` is one line the agent can act on, such as "issue a new charge or tell the customer".
- An inverse runs without review, gets its own row with strategy `none`, and points to the original with `undoes: <rowId>`. Undoing an inverse isn't supported in the MVP.
- Before returning `scheduled`, an adapter checks the service would accept the action now (the payment exists and the amount fits), so most failures come back at once as an error instead of after the hold.
- A held action that later fails at the service gets state `failed`; `undo__history` lists it first and the ledger page sorts it to the top. Telling the session about a late failure is not in the MVP.
- The extension's `instructions.md` adds about 120 tokens: say "scheduled" until the state is `done`; check `undo__history` before telling anyone an action happened; use `undo__undo` to fix your own mistakes.

Row states: `requested`, `blocked`, `awaiting_person`, `held`, `running`, `done`, `failed`, `cancelled`, `undone`, `conflict`, `irreversible`.

## MVP features

### 1. Record everything

`undoPolicy` writes a row for every call, keyed by session and `callId`, before the call runs; the hook fills in the result. A direct connection call, such as a fake Stripe MCP `create_coupon` with no adapter, is recorded even though undo didn't wrap it. A subagent's own calls get rows from the policy, but their results stay empty unless that subagent mounts undo too; undo logs a warning at startup for each subagent without the mount.

### 2. Adapters

Adapters are undo's own tools, with strategy, hold and default approve. They are keyed by Vercel Connect service name, so the catalog grows one Connect service at a time; this is where outside contributors add the most.

| Adapter tool | Strategy | Default approve |
|---|---|---|
| `undo__stripe_refund` | cancel during hold, then none | agent |
| `undo__stripe_capture` | reverse: refund | agent |
| `undo__resend_send` | cancel during hold (Resend `scheduled_at`), then none | agent |

When an adapter exists for a connection's write tool (`stripe__create_refund`, `resend__send_email`), `undoPolicy` denies the direct call with the reason "use `undo__stripe_refund`", so the agent switches to the undoable version on its own. Each adapter lists the connection tool names it covers.

### 3. `reversible()` for your own tools

```ts
// agent/tools/issue_credit.ts
import { reversible } from "undo-eve/agent";
import { z } from "zod";
import { credits } from "../lib/credits";

export default reversible({
  name: "issue_credit", // the tool's final name; must match the file path
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

`reversible()` returns an ordinary eve `defineTool` with strategy `reverse`. `name` is required: at load, undo registers the tool in a process-wide registry under that name, so `undoPolicy` knows its strategy and approve before the call, and the Undo button, `undo__undo` and the sentence box find its `undo` later. A duplicate name logs an error, and a call whose final name differs from `name` fails with an error that says so. `do` gets eve's tool `ctx` (`session`, `abortSignal`, ...) plus `idempotencyKey`; `undo` gets undo's own `ctx`: `idempotencyKey` and `conflict(current)`. Each key is derived from the row, so a retried `do` or a second `undo` repeats it. `undo` is not a durable Workflow step (see above); the row's state machine plus the idempotency key make a retry safe.

### 4. The reviewer

- Runs inside `undoPolicy` for every call whose approve is `agent`, before the call starts and before any hold.
- Sees the call, the session's user messages (such as the ticket) and the session's recent rows. Read-only.
- Approve: the call runs (and holds, for a cancel adapter). Block: the call never runs, and the acting agent gets "blocked by reviewer: <reason>" and replans. Verdict and reason are stored on the row.
- If the review errors or times out, the call is denied with "review unavailable, try once more"; after two such denials for the same tool and input in a session, "review unavailable; don't retry, report it". It never falls back to asking a person.
- It can use a different model from the acting agent.

### 5. Undo in one sentence

`planUndo(sentence, scope)` uses `match` to turn a sentence into rows. One clear match: undo it. Several or none: return the candidates as a question. Two entry points:

- **The ledger page's sentence box** (a person): shows the plan; the person confirms with one click.
- **`undo__undo({ request })`** (the acting agent): runs on its own session's rows without a confirm.

### 6. Ledger page

One page served by the extension at `/undo` on the agent's own server. It polls the API every second and shows every row: tool, summary, state, reviewer verdict and reason, a countdown on held rows, the eve session id, and an **Undo** button on each row that can still be undone. Failed rows sort first. The sentence box sits on top.

| Endpoint | What it does |
|---|---|
| `GET /undo/api/rows` | All rows, newest first (failed first) |
| `POST /undo/api/rows/:rowId/undo` | The Undo button |
| `POST /undo/api/plan` `{ sentence }` | Returns `{ planId, rows }` or `{ question, candidates }` |
| `POST /undo/api/plan/:planId/confirm` | Runs the plan |

The page and API are unauthenticated, so they answer only under `eve dev` and return 404 in a production build until an `auth` option exists. Each read of the API also sweeps due holds. If a call reaches an undo tool or hook with no row, undo logs "undoPolicy is not set in agent.ts".

### 7. Demo: a shop's support agent

An eve agent with Stripe and Resend. In the local MVP both are fakes and every model is scripted. No person until step 3.

1. Alice's ticket says "refund my order". The agent tries `stripe__create_refund` for Bob's order; undo denies it ("use `undo__stripe_refund`"). It calls `undo__stripe_refund` for Bob.
2. The reviewer compares it with the ticket and blocks it ("customer doesn't match the ticket"). The agent replans and calls `undo__stripe_refund` for Alice; the reviewer approves; the refund holds for the demo hold. Meanwhile the agent emails Bob by mistake with `undo__resend_send`. The scripted reviewer only checks payments, so the email passes review and holds too: this is why a hold still matters after a review.
3. Someone types "cancel the email to Bob" in the ledger page's sentence box and confirms: the email is cancelled and never sent. `pnpm demo` plays this step through the same API the page uses (`POST /undo/api/plan`, then `/confirm`).
4. Alice's refund runs when its hold ends. The ledger shows every call with the reviewer's reasons: one refund to Alice in the fake Stripe, no refund to Bob, no email to Bob.

## Local MVP (what Berny tests first)

The first build runs on one machine, spends nothing and needs no accounts:

- **Fakes** for Stripe and Resend in one local server with a request log: idempotency keys, a scheduled email that can be cancelled until it sends, a refund that can't be undone once it's final, a capture that can be refunded. Fake Stripe also serves a small MCP endpoint (`retrieve_customer`, `create_refund`, `create_coupon`) mounted as the demo's `stripe` connection.
- **Scripted models**: the support agent uses eve's `mockModel`; `review` and `match` are scripted functions. No AI Gateway calls. The scripted reviewer proves the wiring, not the judgement.
- **One command** (`pnpm demo`) starts the fakes and the agent on a fresh ledger file, runs steps 1 to 4, and prints the ledger. A short hold (`20s`) keeps it quick. `pnpm demo --keep` leaves everything running so Berny can click through the page.
- **The ledger page** runs locally with an Undo button on every row.
- Swapping fakes for Vercel Connect and scripted functions for real models changes the `services`, `review` and `match` options and two connection files. The README shows the exact lines. It needs Berny's go-ahead, because it can spend money.

## Not in the MVP

- Slack: sentence undo and human approvals in Slack through Vercel Connect, the daily digest. Locally, sentences go through the ledger page, and `approve: "human"` calls are answered through eve's own channel (the `eve dev` terminal or the eve client), while the ledger shows them as `awaiting_person`.
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
- **A registry filled by an app tool module is visible to extension routes** in the same process, including right after a restart and before any turn (spike: yes).
- **An extension hook gets the user's text** from `delivery.consumed` (`parts`), and `node:sqlite` works inside eve's bundle (spike: yes).
- **MCP connection tools** are found with `eve__search` and called through `eve__tool`; the policy sees the resolved name, such as `stripe__create_refund`.
- **Extension routes** serve the ledger page and API (spike: a route on the agent's server works).
- **`mockModel`** scripts replies and tool calls (spike: yes). Structured output from a scripted model goes through `eve__reply`.
- **Stripe**: a refund can't be cancelled once Stripe accepts it (only a refund in `requires_action` can be), so `undo__stripe_refund` holds before it calls Stripe. Stripe takes `Idempotency-Key` on every POST.
- **Resend**: an email sent with `scheduled_at` can be cancelled until it sends (`POST /emails/{id}/cancel`).
- **Not checked yet** (needs real connections): which Stripe and Resend MCP tools carry `readOnlyHint` / `destructiveHint`, and `getToken` from an adapter on Vercel. Until then the policy uses each adapter's lists of read and covered write tools.

## Done looks like

Each item is an automated check against the fakes; the same checks run against Vercel once Berny approves connectors and a deploy.

1. `pnpm demo` runs the demo with no person (step 3 goes through the page's API) and exits 0.
2. A fresh eve agent with the `undo-eve` workspace package plus the two files above (with `mockModel` and a scripted `review`, so it spends nothing) passes `eve build`, records a row, and logs the "reviewing as a write" line for its plain tool.
3. With default settings, no call waits for a person: a session with every default ends with no `awaiting_person` row, and a read gets a row with no reviewer call.
4. A direct fake Stripe MCP write with no adapter is recorded as `irreversible`; one with an adapter is denied with the adapter's name, and the agent then uses the adapter.
5. The reviewer blocks the wrong-customer refund in an eve eval and in the demo; the fake Stripe request log shows no refund to Bob.
6. Undo during a hold (`POST /undo/api/rows/:rowId/undo`): no refund in the fake Stripe log; the email is cancelled in the fake Resend and never sends.
7. Undo after a capture: exactly one refund in the fake Stripe log, even when undo runs twice.
8. "cancel the email to Bob" through `/undo/api/plan` undoes exactly that row; "undo it" gets a question with candidates.
9. A change made by someone else after the agent's `reversible()` write shows as `conflict` on undo, and the newer change is kept.
10. In an eval, the agent calls `undo__undo({ rowId })` on its own email to Bob, and the fake Resend shows it cancelled.
11. Stopping the server during a hold and starting it again runs the held action exactly once on the first ledger API read after the restart, and a `reversible()` row written before the restart is undone through the Undo endpoint before any new turn.
12. A call with `approve: "human"` parks the turn with one `awaiting_person` row and no reviewer call; after a person approves through the eve client, it runs once and the same row ends `irreversible`.
