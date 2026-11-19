import { startFakes } from "./server.ts";

const port = Number(process.env.FAKES_PORT ?? 4500);
const server = await startFakes({ port });
console.log(`[fakes] fake Stripe and Resend at ${server.url} (log: ${server.url}/_log)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void server.close().then(() => process.exit(0)));
}
