# undo

AI agents now take real actions, like purchases, refunds and emails, and when they get it wrong there's no undo button. Undo records everything an agent does, so you can reverse any mistake in one click or one sentence.

undo is an [eve](https://eve.dev) extension, built on Vercel.

```bash
pnpm add @undo/eve
```

```ts
// agent/extensions/undo.ts
import undo from "@undo/eve";
export default undo({ hold: "2m", defaultApprove: "agent" });
```

```ts
// agent/agent.ts: add undo's policy
import { undoPolicy } from "@undo/eve";
export default defineAgent({ model: "anthropic/claude-sonnet-5-5", approval: undoPolicy() });
```

- **Records everything**: every call your agent makes, including connection tools and subagents.
- **Cancel or reverse**: risky actions wait a short hold you can cancel; done actions are reversed with a compensating action; anything that can't be reversed is marked before it runs.
- **Agents check agents**: a reviewer agent approves or blocks held actions. A person approves only where you ask.
- **One click or one sentence**: an Undo button on every action, or "undo the refund to Alice" in Slack. Your agent can undo its own mistakes too.
- **Vercel all the way**: eve, Vercel Workflow, Vercel Connect (Stripe, Resend, Slack and the rest of its catalog), AI Gateway, Agent Runs.

Status: design. The MVP spec is in [docs/mvp.md](docs/mvp.md).

## License

MIT
