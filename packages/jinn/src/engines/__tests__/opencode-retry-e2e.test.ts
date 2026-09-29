import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import type { EngineRunOpts } from "../../shared/types.js";

/**
 * e2e: a pre-stream provider 400 is retried transparently at the
 * provider fetch layer, through Jinn's OpencodeEngine server mode — so it goes
 * through OpencodeServerTurn and its settlement rules.
 *
 * Skipped unless OPENCODE_RETRY_E2E=1 (it spawns a real opencode server).
 *
 *   OPENCODE_RETRY_E2E=1 OPENCODE_BIN=~/.opencode/bin/opencode \
 *   OPENCODE_RETRY_PLUGIN=/path/to/error-retry.js OPENCODE_RETRY_E2E_OUT=/tmp/opencode-retry-e2e \
 *   pnpm exec vitest run src/engines/__tests__/opencode-retry-e2e.test.ts
 */

const RUN = process.env.OPENCODE_RETRY_E2E === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const PLUGIN = process.env.OPENCODE_RETRY_PLUGIN ?? "";
if (RUN && !PLUGIN) throw new Error("OPENCODE_RETRY_PLUGIN must point at error-retry.js for OPENCODE_RETRY_E2E=1");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const MOCK = path.join(HERE, "opencode-retry-mock-upstream.mjs");
const SENTINEL = "OPENCODE_RETRY_RETRY_SENTINEL_7f3a";

const OUT_ROOT = process.env.OPENCODE_RETRY_E2E_OUT ?? path.join(os.tmpdir(), "opencode-retry-e2e-out");
const SUMMARY = path.join(OUT_ROOT, "summary.txt");
fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.writeFileSync(SUMMARY, "");
const record = (s: string) => {
  fs.appendFileSync(SUMMARY, `${s}\n`);
  console.log(s);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs: number, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(300, () => {
      s.destroy();
      resolve(false);
    });
  });
}

interface Case {
  mode: "success" | "exhausted";
  baseDelayMs?: number;
}

async function runCase({ mode, baseDelayMs = 300 }: Case) {
  const outRoot = OUT_ROOT;
  fs.mkdirSync(outRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(outRoot, `case-${mode}-`));
  console.log(`[opencode-retry-e2e] scratch ${home}`);
  const xdgConfig = path.join(home, ".config");
  const xdgData = path.join(home, ".local", "share");
  const workdir = path.join(home, "work");
  const sidefx = path.join(home, "sidefx.log");
  const mockLog = path.join(home, "mock.jsonl");
  fs.mkdirSync(path.join(xdgConfig, "opencode"), { recursive: true });
  fs.mkdirSync(path.join(xdgData, "opencode"), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  const port = 8931 + Math.floor(Math.random() * 400);
  fs.writeFileSync(
    path.join(xdgConfig, "opencode", "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [PLUGIN],
        provider: {
          "opencode-go": {
            options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" },
            models: { "mock-model": { name: "Mock Model" } },
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(xdgData, "opencode", "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api", key: "dummy" } }),
  );
  fs.writeFileSync(
    path.join(xdgConfig, "opencode", "error-retry.json"),
    JSON.stringify({ enabled: true, maxRetries: 3, baseDelayMs, jitter: 0 }),
  );

  const mock: ChildProcess = spawn("node", [MOCK], {
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      MOCK_MODE: mode,
      MOCK_SENTINEL: SENTINEL,
      MOCK_SIDEFX: sidefx,
      MOCK_LOG: mockLog,
    },
    stdio: "ignore",
  });

  const prevEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_DATA_HOME = xdgData;

  const sessionId = `opencode-retry-${mode}-${Date.now()}`;
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 60_000 }) });
  const engine = new OpencodeEngine({ mode: () => "server", servers: pool });

  const requests = (): Array<{ n: number; main: boolean; body: string }> =>
    fs
      .readFileSync(mockLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const mainRequests = () => requests().filter((r) => r.main);
  const sidefxLines = () => (fs.existsSync(sidefx) ? fs.readFileSync(sidefx, "utf8").trim().split("\n").filter(Boolean).length : 0);

  await waitFor(() => true, 1); // yield
  for (let i = 0; i < 50 && !(await canConnect(port)); i += 1) await sleep(100);

  const opts = (over: Partial<EngineRunOpts> = {}): EngineRunOpts => ({
    prompt: `Use your bash tool to run exactly the command below, then reply with exactly the word done.\n\nRun: echo x >> ${sidefx}\n\n${SENTINEL}`,
    cwd: workdir,
    sessionId,
    bin: BIN,
    model: "opencode-go/mock-model",
    ...over,
  });

  const restore = () => {
    if (prevEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = prevEnv.HOME;
    if (prevEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevEnv.XDG_CONFIG_HOME;
    if (prevEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevEnv.XDG_DATA_HOME;
    mock.kill("SIGKILL");
  };

  return { engine, pool, sessionId, opts, requests, mainRequests, sidefxLines, restore, sidefx };
}

/** Stop one case's server and mock before the next starts, so cases do not
 *  share a machine's worth of opencode servers. */
async function stop(c: Awaited<ReturnType<typeof runCase>>) {
  c.engine.killAll();
  await c.pool.stopAll();
  c.restore();
}

/** Run one case once. `check` runs with the case's server still up.
 *
 *  No startup retry: each case's fresh HOME makes opencode npm-install its
 *  plugin's dependencies on the first instance request, which used to land in
 *  the turn's 15 s connect budget and fail it with "the event stream did not
 * connect". Since the pool waits out that bootstrap before handing
 *  the server over. */
async function runOnce(
  mode: "success" | "exhausted",
  check: (c: Awaited<ReturnType<typeof runCase>>, result: { error?: string; result: string; sessionId: string }) => Promise<void>,
  baseDelayMs?: number,
) {
  const c = await runCase({ mode, ...(baseDelayMs === undefined ? {} : { baseDelayMs }) });
  try {
    await check(c, await c.engine.run(c.opts()));
  } finally {
    await stop(c);
  }
}

describe.skipIf(!RUN)("opencode transparent retry (Jinn path)", () => {
  it(
    "retries the pre-stream 400 in place: one side effect, three requests, identical body, turn succeeds",
    async () => {
      await runOnce("success", async (c, result) => {
        expect(result.error).toBeUndefined();
        expect(result.result).toContain("done");

        await waitFor(() => c.mainRequests().length >= 3, 15_000, "3 main requests");
        const main = c.mainRequests();
        expect(main.length).toBe(3);
        expect(main[2]!.body).toBe(main[1]!.body); // same step, not a new prompt
        expect(c.sidefxLines()).toBe(1);

        const server = c.pool.get(c.sessionId)!;
        const messages = (await (
          await fetch(`${server.apiUrl}/session/${result.sessionId}/message`, {
            headers: { authorization: basicAuthHeader(server.password) },
          })
        ).json()) as Array<{ info: { role: string; error?: { name?: string } } }>;
        expect(messages.filter((m) => m.info.role === "user").length).toBe(1);
        expect(messages.filter((m) => m.info.role === "assistant" && m.info.error)).toHaveLength(0);
        record(
          `[opencode-retry-e2e] SUCCESS mainRequests=${main.length} sidefxLines=${c.sidefxLines()} identicalBody=${main[2]!.body === main[1]!.body} users=1 assistantError=0 result=${JSON.stringify(result.result)}`,
        );
      });
    },
    240_000,
  );

  it(
    "exhausted: 1 + (1+3) requests, one side effect, the turn fails as today, and nothing runs after it settles",
    async () => {
      await runOnce("exhausted", async (c, result) => {
        expect(result.error).toBeDefined();
        expect(c.sidefxLines()).toBe(1);

        await waitFor(() => c.mainRequests().length >= 5, 20_000, "5 main requests");
        expect(c.mainRequests().length).toBe(5); // 1 tool + 1 400 + 3 retries
        expect(c.mainRequests()[4]!.body).toBe(c.mainRequests()[1]!.body);

        const before = c.mainRequests().length;
        await sleep(15_000);
        expect(c.mainRequests().length).toBe(before); // no orphan turn
        record(
          `[opencode-retry-e2e] EXHAUSTED mainRequests=${before} error=${JSON.stringify(result.error)} sidefxLines=${c.sidefxLines()} orphanAfter15s=0`,
        );
      });
    },
    240_000,
  );

  it(
    "abort during backoff stops the retry with no further request",
    async () => {
      const c = await runCase({ mode: "exhausted", baseDelayMs: 2000 });
      try {
        const pending = c.engine.run(c.opts());
        await waitFor(() => c.mainRequests().length >= 2, 60_000, "the 400 has come back");
        c.engine.kill(c.sessionId, "Interrupted: opencode retry abort test");
        await pending;

        const before = c.mainRequests().length;
        await sleep(6000);
        expect(c.mainRequests().length).toBe(before); // aborted sleep made no request
        record(`[opencode-retry-e2e] ABORT mainRequestsAtAbort=${before} afterAbort=0`);
      } finally {
        await stop(c);
      }
    },
    240_000,
  );
});
