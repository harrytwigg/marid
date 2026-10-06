import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool, basicAuthHeader } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import type { EngineResult, EngineRunOpts } from "../../shared/types.js";

/**
 * e2e: where opencode's OWN auto-compaction fires, through Jinn's
 * OpencodeEngine in server mode, against a mock provider that reports any
 * token count we like.
 *
 * opencode 1.18 checks overflow at the top of each step of its prompt loop,
 * against a usable budget: `limit.input - compaction.reserved` when the model
 * declares `limit.input`, otherwise `limit.context - maxOutputTokens`, with
 * `compaction.reserved` ignored. The mock model declares the shape the
 * provisioned providers do — `limit.context` and `limit.output`, no
 * `limit.input` — so its native threshold is 100000 - 4000 = 96000. Each case
 * reports a size on turn 1 and looks for a `compaction` part (auto: true) once
 * turn 2 has run.
 *
 * Skipped unless OPENCODE_COMPACTION_E2E=1 (it spawns a real opencode server;
 * no model tokens are spent).
 *
 *   OPENCODE_COMPACTION_E2E=1 OPENCODE_BIN=~/.opencode/bin/opencode \
 *   pnpm exec vitest run src/engines/__tests__/opencode-native-compaction-e2e.test.ts
 */

const RUN = process.env.OPENCODE_COMPACTION_E2E === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const MOCK = path.join(HERE, "opencode-compaction-mock-upstream.mjs");
const OUT_ROOT = process.env.OPENCODE_COMPACTION_E2E_OUT ?? path.join(os.tmpdir(), "opencode-compaction-e2e-out");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  label: string;
  firstPromptTokens: number;
  limit: { context: number; output: number; input?: number };
  reserved?: number;
}

interface StoredMessage {
  info: { role: string; summary?: boolean; mode?: string; error?: unknown };
  parts: Array<{ type: string; auto?: boolean; text?: string; synthetic?: boolean }>;
}

interface Observed {
  turn1: EngineResult;
  turn2: EngineResult;
  messages: StoredMessage[];
  compactionParts: Array<{ auto?: boolean }>;
  summaries: number;
  requests: Array<{ kind: string; body: string }>;
  kinds: string[];
}

async function runCase(c: Case): Promise<Observed> {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(OUT_ROOT, `case-${c.label}-`));
  const xdgConfig = path.join(home, ".config");
  const xdgData = path.join(home, ".local", "share");
  const workdir = path.join(home, "work");
  const mockLog = path.join(home, "mock.jsonl");
  fs.mkdirSync(path.join(xdgConfig, "opencode"), { recursive: true });
  fs.mkdirSync(path.join(xdgData, "opencode"), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

  const port = 9341 + Math.floor(Math.random() * 400);
  fs.writeFileSync(path.join(xdgConfig, "opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(c.reserved === undefined ? {} : { compaction: { reserved: c.reserved } }),
    provider: {
      "opencode-go": {
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "dummy" },
        models: { "mock-model": { name: "Mock Model", limit: c.limit } },
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(xdgData, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "dummy" } }));

  const mock: ChildProcess = spawn("node", [MOCK], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_FIRST_PROMPT_TOKENS: String(c.firstPromptTokens), MOCK_LOG: mockLog },
    stdio: "ignore",
  });
  const prevEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_DATA_HOME = xdgData;

  const sessionId = `opencode-compaction-${c.label}-${Date.now()}`;
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
  const pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 60_000 }) });
  const engine = new OpencodeEngine({ mode: () => "server", servers: pool });
  const opts = (over: Partial<EngineRunOpts>): EngineRunOpts => ({
    prompt: "", cwd: workdir, sessionId, bin: BIN, model: "opencode-go/mock-model", ...over,
  });

  try {
    for (let i = 0; i < 50 && !(await canConnect(port)); i += 1) await sleep(100);
    const turn1 = await engine.run(opts({ prompt: "Say hello in one word." }));
    const turn2 = await engine.run(opts({ prompt: "Say goodbye in one word.", resumeSessionId: turn1.sessionId }));

    const server = pool.get(sessionId)!;
    const messages = (await (await fetch(`${server.apiUrl}/session/${turn1.sessionId}/message`, {
      headers: { authorization: basicAuthHeader(server.password) },
    })).json()) as StoredMessage[];
    const requests = fs.readFileSync(mockLog, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; body: string });
    const kinds = requests.map((r) => r.kind);
    const observed: Observed = {
      turn1,
      turn2,
      messages,
      compactionParts: messages.flatMap((m) => m.parts.filter((p) => p.type === "compaction")),
      summaries: messages.filter((m) => m.info.role === "assistant" && m.info.summary === true).length,
      requests,
      kinds,
    };
    const line = `[opencode-compaction-e2e] ${c.label} firstPromptTokens=${c.firstPromptTokens} limit=${JSON.stringify(c.limit)} `
      + `reserved=${c.reserved ?? "-"} compactionParts=${JSON.stringify(observed.compactionParts.map((p) => ({ auto: p.auto })))} `
      + `summaryMessages=${observed.summaries} requests=${kinds.join(",")} `
      + `turn2=${JSON.stringify({ result: turn2.result, error: turn2.error, contextTokens: turn2.contextTokens })}`;
    fs.appendFileSync(path.join(OUT_ROOT, "summary.txt"), `${line}\n`);
    console.log(line);
    return observed;
  } finally {
    engine.killAll();
    await pool.stopAll();
    if (prevEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = prevEnv.HOME;
    if (prevEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevEnv.XDG_CONFIG_HOME;
    if (prevEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevEnv.XDG_DATA_HOME;
    mock.kill("SIGKILL");
  }
}

const NO_INPUT_LIMIT = { context: 100_000, output: 4_000 };

describe.skipIf(!RUN)("opencode native auto-compaction (Jinn server path)", { timeout: 240_000 }, () => {
  it("fires below the raw context ceiling once a turn crosses context - maxOutput, and the session carries on", async () => {
    const o = await runCase({ label: "over-native", firstPromptTokens: 97_000, limit: NO_INPUT_LIMIT });
    expect(o.turn1.error).toBeUndefined();
    expect(o.compactionParts).toEqual([expect.objectContaining({ auto: true })]);
    expect(o.summaries).toBe(1);
    expect(o.kinds.filter((k) => k === "summary")).toHaveLength(1);
    expect(o.turn2.error).toBeUndefined();
    expect(o.turn2.result).toMatch(/reply \d/);
    // Turn 2's prompt reaches the model on top of the summary, not the history.
    const last = o.requests.filter((r) => r.kind === "main").at(-1)!.body;
    expect(last).toContain("Summary: the user asked for short replies");
    expect(last).toContain("Say goodbye in one word.");
    expect(last).not.toContain("Say hello in one word.");
  });

  it("does not fire under context - maxOutput", async () => {
    const o = await runCase({ label: "under-native", firstPromptTokens: 90_000, limit: NO_INPUT_LIMIT });
    expect(o.compactionParts).toEqual([]);
    expect(o.summaries).toBe(0);
    expect(o.kinds).not.toContain("summary");
    expect(o.turn2.error).toBeUndefined();
  });

  it("ignores compaction.reserved when the model declares no limit.input", async () => {
    const o = await runCase({ label: "reserved-no-input", firstPromptTokens: 50_000, limit: NO_INPUT_LIMIT, reserved: 60_000 });
    expect(o.compactionParts).toEqual([]);
    expect(o.summaries).toBe(0);
    expect(o.kinds).not.toContain("summary");
  });

  it("honours compaction.reserved when the model declares limit.input", async () => {
    const o = await runCase({
      label: "reserved-with-input", firstPromptTokens: 50_000, limit: { ...NO_INPUT_LIMIT, input: 100_000 }, reserved: 60_000,
    });
    expect(o.compactionParts).toEqual([expect.objectContaining({ auto: true })]);
    expect(o.summaries).toBe(1);
    expect(o.turn2.error).toBeUndefined();
  });
});
