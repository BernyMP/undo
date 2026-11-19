# Council review

Members: Claude Opus 5.5 (high effort) and Claude Fable 5.2 (high effort), both run through T3 Code `delegate_task`. Codex and Grok were unavailable in T3 on 2026-11-19. Each round scores the idea, the project, the AX (what the acting agent experiences) and the DX (what the developer installing undo experiences), out of 10. The bar is 9/10 or higher on all four from both members.

## Scores

| Round | Member | Idea | Project | AX | DX |
|---|---|---|---|---|---|
| 1 | Claude Opus 5.5 | 8 | 6 | 6 | 6 |
| 1 | Claude Fable 5.2 | 8 | 6 | 6 | 6 |

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
