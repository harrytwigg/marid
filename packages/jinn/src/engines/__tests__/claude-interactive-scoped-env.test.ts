import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A department-scoped session's local claude, and every process it starts (its shell,
 * its MCP servers), must not inherit the gateway's environment, where config.yaml's
 * `${VAR}` MCP credentials live. It gets the scoped allow-list on every local launch
 * path the interactive engine owns; an unscoped session keeps the gateway's environment.
 * Fork, the one path outside the engine, is covered in sessions/__tests__.
 */

const spawns: Array<{ bin: string; args: string[]; options: { env: Record<string, string>; cwd: string } }> = [];
vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[], options: { env: Record<string, string>; cwd: string }) => {
    spawns.push({ bin, args, options });
    return { pid: 7000 + spawns.length, _exitCode: null, onData() {}, onExit() {}, kill() {}, write() {}, resize() {}, on() {} };
  }),
}));
vi.mock("../sse-pty-proxy.js", () => ({
  MAIN_AGENT_SENTINEL: "<!-- jinn-main-agent:5c1f -->",
  SsePtyProxy: class {
    port = 0;
    constructor(_label: string, _onEvent: (e: unknown) => void) {}
    async start() { return 41300; }
    stop() {}
  },
}));

import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { cleanupSessionSettings } from "../../shared/claude-settings.js";
import { CLAUDE_SETTINGS_DIR } from "../../shared/paths.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { createSession, deleteSession } from "../../sessions/registry.js";
import { resolveEngineRunMcp } from "../../sessions/engine-run-mcp.js";
import { refreshOrg } from "../../gateway/org-registry.js";
import { resetDepartmentFixtures, writeDepartmentFile, writeEmployeeFile } from "../../gateway/__tests__/department-fixtures.js";
import type { Employee, JinnConfig, McpGlobalConfig } from "../../shared/types.js";

const flush = () => new Promise((r) => setTimeout(r, 30));

const ALLOWED_SECRET = "allowed-server-secret";
const OTHER_SECRET = "other-server-secret";
const config = {
  mcp: {
    custom: {
      allowed: { command: "npx", args: ["allowed-mcp"], env: { ALLOWED_API_KEY: "${ALLOWED_API_KEY}" } },
      other: { command: "npx", args: ["other-mcp"], env: { OTHER_API_KEY: "${OTHER_API_KEY}" } },
    },
  } as unknown as McpGlobalConfig,
} as unknown as JinnConfig;

let tmp: string;
let cwd: string;
let lifecycle: PtyLifecycleManager;
let engine: InteractiveClaudeEngine;
const sessionIds: string[] = [];

function sessionOf(employee: string): string {
  const session = createSession({ engine: "claude", source: "web", sourceRef: `web:${employee}`, employee });
  sessionIds.push(session.id);
  return session.id;
}

function expectScopedEnv(env: Record<string, string>, sessionId: string): void {
  expect(env).not.toHaveProperty("ALLOWED_API_KEY");
  expect(env).not.toHaveProperty("OTHER_API_KEY");
  expect(env).not.toHaveProperty("UNRELATED_SECRET");
  expect(env.PATH).toBe(process.env.PATH);
  expect(env.JINN_SESSION_ID).toBe(sessionId);
  expect(env.JINN_DEPARTMENT).toBe("side-project");
  expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe("1");
}

beforeEach(() => {
  spawns.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-interactive-scoped-env-")));
  cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd);
  vi.stubEnv("ALLOWED_API_KEY", ALLOWED_SECRET);
  vi.stubEnv("OTHER_API_KEY", OTHER_SECRET);
  vi.stubEnv("UNRELATED_SECRET", "unrelated");
  vi.stubEnv("JINN_DEPARTMENT", undefined);
  resetDepartmentFixtures();
  setJinnAttachGate({ ok: true });
  writeDepartmentFile("side-project", "name: side-project\nscope: scoped\nmcp: [allowed]\n");
  writeEmployeeFile("engineering", "eng-dev");
  writeEmployeeFile("side-project", "side-dev");
  refreshOrg();
  lifecycle = new PtyLifecycleManager({ maxLivePtys: 10 });
  engine = new InteractiveClaudeEngine(lifecycle, { register: () => {}, unregister: () => {} } as any);
});

afterEach(() => {
  lifecycle.killAll();
  for (const id of sessionIds.splice(0)) {
    cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
    deleteSession(id);
  }
  setJinnAttachGate(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a department-scoped session's local claude environment", () => {
  it("the turn spawn carries no MCP credential, while the allow-listed server still gets its key through the MCP config", async () => {
    const sid = sessionOf("side-dev");
    const mcp = resolveEngineRunMcp({ config, employee: { name: "side-dev", engine: "claude" } as Employee, engine: "claude", sessionId: sid });
    void engine.run({ sessionId: sid, prompt: "hi", cwd, ...mcp } as any).catch(() => {});
    await flush();
    expect(spawns).toHaveLength(1);
    expectScopedEnv(spawns[0]!.options.env, sid);
    expect(spawns[0]!.options.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:41300");
    const written = fs.readFileSync(mcp.mcpConfigPath!, "utf-8");
    expect(written).toContain(ALLOWED_SECRET);
    expect(written).not.toContain(OTHER_SECRET);
  });

  it("the redelivery respawn (also how a rate-limited turn is retried)", async () => {
    const sid = sessionOf("side-dev");
    const resolver = { isSettled: false, promptSubmittedAt: undefined, sessionId: undefined, newProcess() {}, interrupt() {} };
    await (engine as any).redeliverByRespawn(sid, { resolver } as any, { sessionId: sid, prompt: "hi", cwd } as any, Date.now(), () => {});
    expect(spawns).toHaveLength(1);
    expectScopedEnv(spawns[0]!.options.env, sid);
  });

  it("the idle PTY spawn the terminal view attaches to", async () => {
    const sid = sessionOf("side-dev");
    engine.ensureIdleSpawn(sid, { cwd });
    await flush();
    expect(spawns).toHaveLength(1);
    expectScopedEnv(spawns[0]!.options.env, sid);
  });

  it("the terminal view's restart", async () => {
    const sid = sessionOf("side-dev");
    engine.restartPty(sid, { cwd });
    await flush();
    expect(spawns).toHaveLength(1);
    expectScopedEnv(spawns[0]!.options.env, sid);
  });
});

describe("an unscoped session's local claude environment", () => {
  it("is the gateway's, as before", async () => {
    const sid = sessionOf("eng-dev");
    void engine.run({ sessionId: sid, prompt: "hi", cwd } as any).catch(() => {});
    engine.ensureIdleSpawn(sessionOf("eng-dev"), { cwd });
    await flush();
    expect(spawns).toHaveLength(2);
    for (const spawn of spawns) {
      expect(spawn.options.env.OTHER_API_KEY).toBe(OTHER_SECRET);
      expect(spawn.options.env.UNRELATED_SECRET).toBe("unrelated");
      expect(spawn.options.env).not.toHaveProperty("JINN_DEPARTMENT");
    }
  });
});
