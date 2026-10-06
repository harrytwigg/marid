import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

/**
 * e2e: the context budget through `runTurn` and the REAL opencode engine in
 * server mode — a real `opencode serve`, a mock provider that reports whatever
 * token count it is told to. The session's first turn reads 50k tokens, past a
 * 40k budget but far under opencode's own threshold (100000 − 4000), so the
 * compaction in front of the second turn can only be Jinn's: opencode's
 * summarize with `auto: false`, after which the message runs on the summary.
 *
 * Skipped unless OPENCODE_COMPACTION_E2E=1 (it spawns a real opencode server;
 * no model tokens are spent).
 *
 *   OPENCODE_COMPACTION_E2E=1 OPENCODE_BIN=~/.opencode/bin/opencode \
 *   pnpm exec vitest run src/sessions/__tests__/auto-compact-budget-opencode-e2e.test.ts
 */

const RUN = process.env.OPENCODE_COMPACTION_E2E === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const MODEL = "opencode-go/mock-model";
const MOCK = path.join(path.dirname(new URL(import.meta.url).pathname), "../../engines/__tests__/opencode-compaction-mock-upstream.mjs");

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const { reg, recordingSurface, configWith, runOne } = await import("./helpers/auto-compact-harness.js");
const { OpencodeEngine } = await import("../../engines/opencode.js");
const { OpencodeServerPool, basicAuthHeader } = await import("../../engines/opencode-server.js");
const { PtyLifecycleManager } = await import("../../engines/pty-lifecycle.js");

/** Whether the mock upstream is accepting connections yet. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await canConnect(port))) {
    if (Date.now() > deadline) throw new Error(`mock upstream never listened on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface StoredMessage {
  info: { role: string; summary?: boolean };
  parts: Array<{ type: string; auto?: boolean }>;
}

describe.skipIf(!RUN)("the context budget against a real opencode server", { timeout: 240_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-budget-e2e-"));
  const mockLog = path.join(home, "mock.jsonl");
  const port = 9741 + Math.floor(Math.random() * 400);
  const prevEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  let mock: ChildProcess;
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 60_000 }) });
  const engine = new OpencodeEngine({ mode: () => "server", servers: pool });

  beforeAll(async () => {
    const xdgConfig = path.join(home, ".config");
    const xdgData = path.join(home, ".local", "share");
    fs.mkdirSync(path.join(xdgConfig, "opencode"), { recursive: true });
    fs.mkdirSync(path.join(xdgData, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(xdgConfig, "opencode", "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        "opencode-go": {
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" },
          models: { "mock-model": { name: "Mock Model", limit: { context: 100_000, output: 4_000 } } },
        },
      },
    }));
    fs.writeFileSync(path.join(xdgData, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "dummy" } }));
    mock = spawn("node", [MOCK], {
      env: { ...process.env, MOCK_PORT: String(port), MOCK_FIRST_PROMPT_TOKENS: "50000", MOCK_LOG: mockLog },
      stdio: "ignore",
    });
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_DATA_HOME = xdgData;
    await waitForPort(port);
  });

  afterAll(async () => {
    engine.killAll();
    await pool.stopAll();
    mock?.kill("SIGKILL");
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("compacts in front of the turn after the session crosses its budget, and the turn runs on the summary", async () => {
    const config = configWith({ enabled: true, maxContextTokens: 40_000 }, "opencode");
    Object.assign(config.engines.opencode as NonNullable<JinnConfig["engines"]["opencode"]>, { bin: BIN, model: MODEL });
    const sessionId = reg.createSession({ engine: "opencode", source: "web", sourceRef: "web:budget-e2e", model: MODEL }).id;

    await runOne(engine, sessionId, "Say hello in one word.", recordingSurface().surface, config);
    expect(reg.getSession(sessionId)!.lastContextTokens).toBe(50_000);

    const { surface, seen } = recordingSurface();
    await runOne(engine, sessionId, "Say goodbye in one word.", surface, config);

    expect(seen.notices).toEqual(["🗜️ Auto-compacted this session before the next message (it was 50.0k tokens; past its context budget of 40.0k tokens)."]);
    expect(seen.receipts).toHaveLength(1);
    expect(seen.receipts[0]!.error ?? null).toBeNull();
    expect(seen.receipts[0]!.result).toMatch(/reply \d/);

    const requests = fs.readFileSync(mockLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; body: string });
    expect(requests.filter((r) => r.kind === "summary")).toHaveLength(1);
    const last = requests.filter((r) => r.kind === "main").at(-1)!.body;
    expect(last).toContain("Summary: the user asked for short replies");
    expect(last).toContain("Say goodbye in one word.");
    expect(last).not.toContain("Say hello in one word.");

    // Jinn's compaction (auto: false), not opencode's own.
    const thread = reg.getSession(sessionId)!.engineSessions!.opencode!.id!;
    const server = pool.get(sessionId)!;
    const stored = await (await fetch(`${server.apiUrl}/session/${thread}/message`, {
      headers: { authorization: basicAuthHeader(server.password) },
    })).json() as StoredMessage[];
    expect(stored.flatMap((m) => m.parts.filter((p) => p.type === "compaction"))).toEqual([expect.objectContaining({ auto: false })]);
    expect(stored.filter((m) => m.info.summary === true)).toHaveLength(1);

    // The turn read the context back under the budget: the next one runs straight through.
    expect(reg.getSession(sessionId)!.lastContextTokens).toBeLessThan(40_000);
    await runOne(engine, sessionId, "Say thanks in one word.", recordingSurface().surface, config);
    const after = fs.readFileSync(mockLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
    expect(after.filter((r) => r.kind === "summary")).toHaveLength(1);
  });
});
