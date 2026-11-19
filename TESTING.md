# Testing undo locally

Everything here runs on your machine. It uses local fakes for Stripe and Resend and scripted models, so nothing contacts a paid service, nothing is deployed, and nothing costs money.

You need Node 24 and pnpm 11. Each step says what you should see.

## 1. Install

```bash
git clone https://github.com/BernyMP/undo && cd undo
pnpm install
```

You should see pnpm finish with `Done`. Installing also builds the extension (`[BUILD] built extension undo-eve`).

## 2. Run the demo (one command)

```bash
pnpm demo
```

It takes about 40 seconds: around 10 to start, then the 20-second hold. You should see:

1. **Startup.** The fakes' URL, the agent's URL, the ledger page URL, and `hold: 20s`.
2. **Steps 1-2.** Alice's ticket arrives and no person is watching. The agent's calls appear as rows:
   - `r1 stripe__list_payment_intents … done`: a read, recorded with no review.
   - `r2 stripe__create_refund … blocked`, with `↳ use undo__stripe_refund; it can be undone for 20s…`. The direct Stripe write was redirected.
   - `r3 undo__stripe_refund refund … pi_bob … blocked`, with `↳ blocked by reviewer: customer doesn't match the ticket (pi_bob is Bob's order)`.
   - `r4 undo__stripe_refund refund $42.00 on pi_alice … held until <time>`.
   - `r5 undo__resend_send email bob@example.com … held until <time>`: the mistaken email. It passed review, and only the hold saves it.
   - `r6 stripe__create_coupon … irreversible`: a write with no adapter, labelled before it ran.
   - The agent's reply: `Alice's refund of $42.00 is scheduled (r4, final at …)`.
3. **Step 3.** `"cancel the email to Bob"` finds exactly `r5`, and confirming prints `r5 cancelled`. `"undo it"` gets a question instead of a guess.
4. **Step 4.** After the hold, `r4 … → irreversible (sent to Stripe; final now)`.
5. **The ledger and what the fake services saw.** `Stripe refunds: pi_alice $42.00` and `Resend emails: bob@example.com canceled`.
6. **Checks.** Nine green ✓ lines, then `Demo passed.` The exit code is 0.

## 3. Click through the ledger page

```bash
pnpm demo --keep
```

The same demo runs, then everything stays up. Open the `ledger page` URL it prints (`http://127.0.0.1:<port>/undo`). You should see:

- Every row from the demo, newest first, with its state chip, strategy, the reviewer's verdict and reason, and its session.
- An **Undo** button only on rows that can still be undone. After the demo finishes, none can: the refund is final and the email is cancelled.

To get rows you can undo, talk to the agent from a second terminal. Use the agent URL the demo printed:

```bash
cd examples/support-agent
pnpm exec eve remote connect --url http://127.0.0.1:<port>/
```

Then type one of these (the scripted model reacts to these phrases):

| Type | What happens | On the page |
|---|---|---|
| `Please give Alice $5 store credit.` | `issue_credit` runs. It is your own tool, wrapped in `reversible()`. | A `done` row with an **Undo** button. Click it: the row turns `undone` and a `undo of issue_credit` row appears. |
| `Email Bob about his order, then take it back.` | The agent emails Bob, sees the mistake, and calls `undo__undo` itself. | The email row is `cancelled` and an `undo__undo` row appears. |
| `Please give Alice a 100% coupon.` | Coupons over 50% need a person, so the call waits. | An `awaiting_person` row. Approve it in the terminal; it runs once and ends `irreversible`. |

To see a held row with a countdown, run with a longer hold, `UNDO_HOLD=2m pnpm demo --keep`, and open the page during step 4. Alice's refund shows `held · Ns left` and an **Undo** button. Clicking it cancels the refund, and the fakes' log (`<fakes URL>/_log`) shows no refund.

The sentence box takes plain words: `cancel the email to Bob`, `undo the credit to cus_alice`. One clear match shows a **Confirm** button; anything vague gets a question.

Press Ctrl-C to stop.

## 4. Run the tests

```bash
pnpm typecheck   # TypeScript, all packages
pnpm test        # fakes and undo's core: 31 tests, about 5 s
pnpm test:e2e    # the real agent under eve dev on the fakes: 6 tests, about 2 min
pnpm eval        # two eve evals (Done #5 and #10)
pnpm check       # all of the above, then the demo
```

Each should end green: `Tests  N passed`, `Results: 2 passed`, `Demo passed.`

### Where each "Done looks like" item is checked

| Done item (docs/mvp.md) | Checked by |
|---|---|
| 1. The demo runs with no person, exits 0 | `pnpm demo` |
| 2. A fresh agent with the two files builds, records a row, logs its plain tool | `pnpm test:e2e` (#2), using `examples/fresh-agent` |
| 3. No call waits for a person by default; reads aren't reviewed | `pnpm test:e2e` (#3), `pnpm test` (undoPolicy) |
| 4. A direct MCP write is redirected, or recorded as irreversible | `pnpm test:e2e` (#4), `pnpm demo` |
| 5. The reviewer blocks the wrong customer; Stripe never sees it | `pnpm eval` (reviewer-blocks-wrong-customer), `pnpm test:e2e`, `pnpm demo` |
| 6. Undo during a hold: no refund; the email is cancelled | `pnpm test:e2e` (#6), `pnpm test` (cancel strategy) |
| 7. Undo after a capture: one refund, even run twice | `pnpm test` (reverse strategy) |
| 8. A sentence undoes exactly one row; a vague one asks | `pnpm test:e2e` (#8), `pnpm test`, `pnpm demo` |
| 9. A hand edit after a `reversible()` write is a conflict, and kept | `pnpm test:e2e` (#9), `pnpm test` |
| 10. The agent undoes its own email | `pnpm eval` (agent-undoes-its-own-email), `pnpm test:e2e` (#10) |
| 11. A restart during a hold runs it once; a `reversible()` row undoes before any turn | `pnpm test:e2e` (#11), `pnpm test` (restart, lease) |
| 12. `approve: "human"` parks the call, then runs once after approval | `pnpm test:e2e` (#12) |

## What isn't tested, and why

- **Real Stripe, Resend and Slack, and real models.** They need Vercel Connect connectors, AI Gateway credits or a deploy, and each of those needs your approval and a spending ceiling. The default reviewer and matcher (`decide` through AI Gateway) are written but never run in these tests.
- **The `undo__sweep` schedule.** `eve dev` doesn't fire schedules on their cadence. Locally, the in-process timer and the sweep on every ledger read cover it (Done #11).
- **Which real Stripe and Resend MCP tools carry `readOnlyHint` / `destructiveHint`.** Checking that needs a real connection.
