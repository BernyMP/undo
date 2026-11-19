// Starts the local stack for the demo and the end-to-end tests: the fake Stripe
// and Resend server (in this process) and the support agent under `eve dev` (a
// child process), on free ports, with a fresh ledger file.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { startFakes, type FakesServer } from "undo-fakes";

export const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export type Stack = {
  fakes: FakesServer;
  url: string;
  ledger: string;
  client: Client;
  logs: () => string;
  /** Restart the agent process (same ledger, same fakes). */
  restart(): Promise<void>;
  stopAgent(): Promise<void>;
  stop(): Promise<void>;
};

/** The parent's env without test-runner variables, which change how eve dev behaves. */
export function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("VITEST") || k === "NODE_ENV" || k === "TEST" || k.startsWith("JEST")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startStack(opts: { hold?: string; fakesPort?: number; agentPort?: number; ledger?: string } = {}): Promise<Stack> {
  const fakes = await startFakes({ port: opts.fakesPort ?? 0 });
  const port = opts.agentPort ?? (await freePort());
  const ledger = opts.ledger ?? join(mkdtempSync(join(tmpdir(), "undo-demo-")), "ledger.db");
  const url = `http://127.0.0.1:${port}`;
  let output = "";
  let earlier = "";
  let child: ChildProcess | undefined;

  const startAgent = async () => {
    earlier += output;
    output = "";
    child = spawn(join(APP_DIR, "node_modules/.bin/eve"), ["dev", "--no-ui", "--port", String(port)], {
      cwd: APP_DIR,
      env: childEnv({ FAKES_URL: fakes.url, UNDO_HOLD: opts.hold ?? "20s", UNDO_LEDGER: ledger, NO_COLOR: "1" }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    const started = Date.now();
    while (!/ready at/.test(output)) {
      if (child.exitCode !== null) throw new Error(`eve dev exited (${child.exitCode}):\n${output}`);
      if (Date.now() - started > 120_000) throw new Error(`eve dev didn't start in 2 minutes:\n${output}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const stopAgent = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child!.once("exit", r));
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };

  await startAgent();
  return {
    fakes,
    url,
    ledger,
    client: new Client({ baseUrl: url }),
    logs: () => earlier + output,
    restart: async () => {
      await stopAgent();
      await startAgent();
    },
    stopAgent,
    stop: async () => {
      await stopAgent();
      await fakes.close();
    },
  };
}

export async function api<T = any>(stack: Stack, path: string, body?: unknown): Promise<T> {
  const res = await fetch(stack.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs: number, what: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const TICKET = "Hi, this is Alice (cus_alice). Please refund my order pi_alice, the scarf arrived torn.";
