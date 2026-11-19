# undo

AI agents now take real actions, like purchases, refunds and emails, and when they get it wrong there's no undo button. Undo records everything an agent does, so you can reverse any mistake in one click or one sentence.

undo is an [eve](https://eve.dev) extension, built on Vercel.

```bash
pnpm add undo-eve   # working name; not published yet
```

```ts
// agent/extensions/undo.ts  (the filename must be undo.ts)
import { undo } from "undo-eve/agent";
export default undo({ hold: "2m", adapters: { stripe: "stripe", resend: "resend" } });
```

```ts
// agent/agent.ts: add undo's policy
import { undoPolicy } from "undo-eve/agent";
export default defineAgent({ model: "anthropic/claude-sonnet-5.5", approval: undoPolicy() });
```

- **Records every call** your agent makes, including connection tools. A subagent's own calls are recorded in full when it mounts undo too.
- **Cancel or reverse**: risky actions wait a short hold you can cancel; done actions are reversed with a compensating action; anything that can't be reversed is labelled before it runs.
- **Agents check agents**: a reviewer approves or blocks writes to outside services before they run. A person approves only where you set `approve: "human"`. Your own tools count as writes until you list read-only ones in `reads`; undo logs each one the first time it reviews it.
- **One click or one sentence**: an Undo button on every row that can still be undone, or "cancel the email to Bob". Your agent can undo its own mistakes with `undo__undo`.
- **Your own tools**: wrap a tool in `reversible({ do, undo })` and it gets the same Undo button.
- **Built on Vercel**: eve, Vercel Connect (Stripe, Resend and the rest of its catalog) and AI Gateway.

Status: design. The MVP spec is in [docs/mvp.md](docs/mvp.md); the review rounds are in [docs/council.md](docs/council.md).

## License

MIT
