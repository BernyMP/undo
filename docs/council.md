# Council review

Members: Claude Opus 5.5 (high effort) and Claude Fable 5.2 (high effort), both run through T3 Code `delegate_task`. Codex and Grok were unavailable in T3 on 2026-11-19. Each round scores the idea, the project, the AX (what the acting agent experiences) and the DX (what the developer installing undo experiences), out of 10. The bar is 9/10 or higher on all four from both members.

## Scores

| Round | Member | Idea | Project | AX | DX |
|---|---|---|---|---|---|
| 1 | Claude Opus 5.5 | 8 | 6 | 6 | 6 |
| 1 | Claude Fable 5.2 | 8 | 6 | 6 | 6 |
| 2 | Claude Opus 5.5 | 8 | 8 | 8 | 7 |
| 2 | Claude Fable 5.2 | 9 | 8 | 8 | 8 |
| 3 | Claude Opus 5.5 | 9 | 9 | 9 | 8 |
| 3 | Claude Fable 5.2 | 9 | 8 | 9 | 9 |
| 4 | Claude Opus 5.5 | 9 | 9 | 9 | 9 |
| 4 | Claude Fable 5.2 | 9 | 9 | 9 | 9 |

Round 4 met the bar: both members scored all four at 9.

## Round 1 (2026-11-19)

Reviewed: docs/mvp.md and README.md at commit dec45ab.

Main objections (both members unless noted):

- **Review and hold contradicted each other.** The spec said a reviewer's approval releases a held action at once, so a reviewer-approved wrong refund had no cancel window, and Done #6 couldn't happen for the refund adapter.
- **`reversible()` couldn't be built as written.** eve needs `"use workflow"` entry points and top-level `"use step"` functions; `ctx.stepId` and `ctx.conflict` aren't eve APIs; nothing said how the Undo button finds an inverse later.
- **No agent contract.** The acting agent's results (scheduled, blocked, denied, undone, conflict, irreversible, ambiguous) and the inputs and outputs of `undo__undo` / `undo__history` weren't specified, and no instruction fragment was given.
- **The local MVP was too wide.** Slack, the daily digest, trigger forwarding, "Undo run" / "Undo to here", a live Next.js UI and (Fable) the undoer subagent weren't needed for any Done item.
- **Fakes and scripted models were underspecified.** Done #4 needs a fake Stripe MCP; the reviewer's model couldn't be swapped for a scripted one (Opus).
- **Config was scattered** across two files with no place for per-tool approval, connection-to-adapter mapping, or the scripted check (Fable).
- Minor: "records everything … subagents" overclaimed; a failed `decide` would fall back to asking a person; an existing `approval` policy couldn't be combined with undo's.

What changed for round 2:

- A spike against eve 1.1.0 found that extensions can't contain Workflow directives at all. Holds moved into the ledger's own state machine (timer plus an `undo__sweep` schedule); Resend holds natively with `scheduled_at`.
- The reviewer moved into `undoPolicy` and runs before any hold; the hold always runs its full length.
- `reversible()` is a plain `defineTool` with a registry-backed inverse and a row-derived idempotency key.
- Added the agent contract table, row states, the instruction fragment and one config table; `undoPolicy(existing)` composes.
- Cut Slack, the digest, trigger forwarding, the undoer subagent, "Undo run" / "Undo to here", Next.js and the authorization adapter from the MVP. The ledger page is one extension route.
- Fake Stripe serves MCP for the direct-write check. Every Done item is worded against the fakes.

## Round 2 (2026-11-19)

Reviewed: docs/mvp.md and README.md at commit 28f1317, plus the spike code. Both members said round 1's fixes hold.

Main objections:

- **No read/write precedence.** With `defaultApprove: "agent"`, eve's default `bash`, `write_file` and `edit_file` calls would each get a reviewer call and an `irreversible` label; the read-name heuristic could let a write skip review (both).
- **Row identity.** eve's `callId` is unique only within a session, and `mockModel` repeats ids across runs, so rows and idempotency keys could collide across demo runs (Fable).
- **`reversible()` keyed by description** can't be seen by the policy (which gets only the tool name), breaks when a description changes, and might not load after a restart (both).
- **Gaps in the Done list**: no check for the agent undoing its own mistake, the one-click button, or a hold surviving a restart; the demo's step 3 needed a person inside a 20-second hold (both).
- Minor: the policy recheck after a person's approval; a retry cap on "review unavailable"; `followUp`, `current` and undo-of-an-inverse undefined; late failures reach nobody; the unauthenticated page; a missing `undoPolicy` failing silently; `eve dev` never fires schedules.

What changed for round 3:

- A six-rule precedence list in "How a call flows", a `reads` option, and no name guessing.
- Rows keyed by session plus `callId`; the demo starts from a fresh ledger file.
- `reversible({ name })` is required and keyed by final tool name; the config `approve` map wins; `ctx` is undo's own. A spike confirmed the registry is filled after a restart before any turn.
- Done grew to 11 items: the agent undoing its own email, the Undo endpoint, and a restart during a hold. `pnpm demo` plays step 3 through the page's API; `pnpm demo --keep` leaves it up for clicking.
- Defined `current`, `followUp` and inverse rows; added the retry cap, adapter pre-checks, failed-first ordering, a dev-only page, a missing-policy warning, and a sweep at startup and on every API read.

## Round 3 (2026-11-19)

Reviewed: docs/mvp.md and README.md at commit 4e01a19. Both members said round 2's fixes hold, apart from the end states below.

Main objections:

- **Your own read tools look like writes** (Opus, DX): with `defaultApprove: "agent"`, a plain `lookup_order` gets a reviewer call and an `irreversible` label, and nothing tells the developer.
- **End states were incomplete** (Fable): reads and sandbox rows had no end state; calls eve doesn't send to the policy (`eve__search`, `eve__skill`, task controls) would trigger the "undoPolicy is not set" warning; the redirect denial had no row state.
- **Holes in the hold state machine** (both): a crash after the compare-and-set strands a row in `running`; a sweep at module load would run held actions during `eve build`; Resend's way out of `held` was undefined.
- **`approve: "human"` was never exercised** by a Done item (Fable).
- Minor: the default reviewer can't produce a free-text reason with `decide`; sandbox tools can reach the network; `undo__history` filled with reads; "same call" in the retry cap never matches because `callId` changes; `reversible()` results and `do`'s context were undefined; the restart claim for the registry needed a Done check; README wording.

What changed for round 4:

- A first-call log line for each plain tool reviewed as a write; the README says so; Done #2 checks it.
- Defined end states: reads and sandbox calls end `done`, only rule-6 writes end `irreversible`, redirects end `blocked`; the hook writes rows for eve's ungated calls without warning; `undoPolicy` denies with a clear message when `undo()` never ran.
- A 60-second lease re-runs stuck `running` rows with the same idempotency key; the executor starts on first runtime use, never at module load; Resend's sweep reads the email's status at `undoUntil`.
- Done #12 checks `approve: "human"` end to end; Done #3 and #11 grew a read-row check and a registry-after-restart check.
- The default reviewer and matcher are concrete `decide` choice questions; sandbox network wording; `undo__history` hides reads and undo's own calls; "same tool and input"; `reversible()` results and contexts; a `subagents` option.

## Round 4 (2026-11-19)

Reviewed: docs/mvp.md and README.md at commit e52690a. Both members scored 9 on all four and said round 3's fixes hold against the eve 1.1.0 docs. Every remaining objection was marked MINOR.

Minor objections, and what was done after the round:

- `undo__resend_send` defaulted to approve `none`, against "otherwise another agent checks" (Opus). Now `agent`; the demo's scripted reviewer passes the Bob email, which shows why the hold still matters.
- A subagent without undo is told to use an adapter it doesn't have (Opus). The denial now adds "If you don't have undo__stripe_refund, this write isn't allowed here".
- Some end states were inferred from the policy's return value (both). The hook now sets them from eve's events: an approval interaction makes the row `awaiting_person`, a rejected call ends `blocked`, and a cleared call never started by turn end ends `blocked`. The hook never overwrites `held`.
- eve built-ins (`agent`, `eve__` tools, `sleep`, `no_reply`) needed explicit handling (Fable). `agent` is in rule 5; ungated built-ins end `done`; the missing-policy warning fires only if the policy never ran.
- Done #2 must run without spending (Fable): reworded with `mockModel` and a scripted `review`. The model id uses the dotted Gateway form.
- The registry-after-restart claim needed a spike without the tool import (Fable). Already run in round 2's spike: the route saw the `reversible()` tool before any turn, with a mount file that didn't import it. Done #11 checks it in the build.
- Kept: `undo__stripe_capture` (Opus suggested cutting it). It was already built and tested by then, and it is the only adapter with a reverse strategy.
- Wording: `undo__history` hides only reads and its own calls; adapters keyed in `approve` by their `undo__` names; subagents reuse the root's config; the fakes ship as their own package; Done #11 says the held action runs on the first API read after a restart.
