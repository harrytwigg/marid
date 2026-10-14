import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { OpencodeEngine } from "../opencode.js";
import { OpencodeServerPool } from "../opencode-server.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/**
 * e2e: a provider fallback plugin through Jinn's OpencodeEngine server mode.
 * The default provider refuses every request with a Go usage limit; the
 * opencode-rate-limit plugin aborts the turn and re-sends its prompt on a
 * second provider, which answers. That answer must be the turn's result.
 *
 * Skipped unless OPENCODE_FALLBACK_E2E=1. It spawns a real opencode server,
 * which installs the plugin from the npm registry on first use.
 *
 *   OPENCODE_FALLBACK_E2E=1 OPENCODE_BIN=/path/to/opencode \
 *   pnpm exec vitest run src/engines/__tests__/opencode-fallback-e2e.test.ts
 */

const RUN = process.env.OPENCODE_FALLBACK_E2E === "1";
const BIN = process.env.OPENCODE_BIN ?? "opencode";
const PLUGIN = process.env.OPENCODE_FALLBACK_PLUGIN ?? "opencode-rate-limit@1.4.0";
const MOCK = path.join(path.dirname(new URL(import.meta.url).pathname), "opencode-fallback-mock-upstream.mjs");
const ANSWER = "FALLBACK_E2E_ANSWER_5c1e";

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

function writeConfig(home: string, port: number): void {
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  };
  write(path.join(home, ".config", "opencode", "opencode.json"), {
    model: "opencode-go/deepseek-v4.1-flash",
    plugin: [PLUGIN],
    provider: {
      "opencode-go": { options: { baseURL: `http://127.0.0.1:${port}/go/v1`, apiKey: "dummy" }, models: { "deepseek-v4.1-flash": { name: "Go" } } },
      openrouter: { options: { baseURL: `http://127.0.0.1:${port}/or/v1`, apiKey: "dummy" }, models: { "deepseek/deepseek-v4.1-flash": { name: "Fallback" } } },
    },
  });
  write(path.join(home, ".opencode", "rate-limit-fallback.json"), {
    enabled: true,
    fallbackMode: "stop",
    cooldownMs: 300_000,
    fallbackModels: [{ providerID: "openrouter", modelID: "deepseek/deepseek-v4.1-flash" }],
    retryPolicy: { maxRetries: 2, strategy: "exponential", baseDelayMs: 1000, jitterEnabled: true },
    circuitBreaker: { enabled: true, failureThreshold: 3, recoveryTimeoutMs: 300_000 },
  });
  write(path.join(home, ".local", "share", "opencode", "auth.json"), {
    "opencode-go": { type: "api", key: "dummy" },
    openrouter: { type: "api", key: "dummy" },
  });
}

describe.skipIf(!RUN)("opencode provider fallback plugin (Jinn path)", () => {
  it("returns the fallback provider's answer to the re-sent prompt as the turn's result", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-fallback-e2e-"));
    const port = 9400 + Math.floor(Math.random() * 400);
    writeConfig(home, port);
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    const mockLog = path.join(home, "mock.jsonl");
    const mock: ChildProcess = spawn(process.execPath, [MOCK], {
      env: { ...process.env, MOCK_PORT: String(port), MOCK_LOG: mockLog, MOCK_ANSWER: ANSWER },
      stdio: "ignore",
    });
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    const lifecycle = new PtyLifecycleManager({ maxLivePtys: 8, enforceLocalCap: false });
    const pool = new OpencodeServerPool(lifecycle, { bin: () => BIN, limits: () => ({ startTimeoutMs: 120_000 }) });
    const engine = new OpencodeEngine({ mode: () => "server", servers: pool });
    try {
      for (let i = 0; i < 50 && !(await canConnect(port)); i++) await new Promise((r) => setTimeout(r, 100));
      const result = await engine.run({
        prompt: "Reply with one word.",
        cwd: path.join(home, "work"),
        sessionId: `opencode-fallback-${Date.now()}`,
        bin: BIN,
        model: "opencode-go/deepseek-v4.1-flash",
      });
      const requests = fs.readFileSync(mockLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { url: string; main: boolean });
      console.log(`[opencode-fallback-e2e] result=${JSON.stringify(result.result)} error=${JSON.stringify(result.error)} main=${JSON.stringify(requests.filter((r) => r.main).map((r) => r.url))}`);
      expect(requests.some((r) => r.main && r.url.startsWith("/go/"))).toBe(true);
      expect(requests.some((r) => r.main && r.url.startsWith("/or/"))).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.result).toBe(ANSWER);
    } finally {
      engine.killAll();
      await pool.stopAll();
      mock.kill("SIGKILL");
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 240_000);
});
