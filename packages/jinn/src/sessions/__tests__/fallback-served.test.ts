import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { TurnSurface } from "../turn/types.js";

/**
 * `fallbackServedBy` is the target that served the latest turn. A hop records its
 * own; a turn that settles the ordinary way records the target the session is on,
 * once the session has walked a chain.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));
vi.mock("../../shared/claude-profile-signin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-profile-signin.js")>()),
  verifyLocalClaudeProfile: () => undefined,
}));
vi.mock("../claude-auth-watch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth-watch.js")>()),
  refuseClaudeLaunch: () => undefined,
  observeClaudeTurnOutcome: () => {},
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-served-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { withServedTarget } = await import("../fallback-served.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");

const DIR_B = path.join(tmp, "claude-b");
const profileB = claudeProfileFromDir(DIR_B);
const ACCOUNT_B = `claude:${profileB.key}`;
const config = { gateway: {}, engines: { default: "claude", claude: { model: "opus", accounts: { B: { configDir: DIR_B } } } }, sessions: {} } as unknown as JinnConfig;

const surface: TurnSurface = {
  started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {}, settled: async () => {},
};

function claudeEngine(): Engine {
  return { name: "claude", async run(_opts: EngineRunOpts): Promise<EngineResult> { return { sessionId: "thread", result: "answered" }; } } as Engine;
}

async function runOne(id: string): Promise<void> {
  reg.insertMessage(id, "user", "hello");
  const started = reg.beginSessionAttempt(id)!;
  await runTurn({
    session: reg.getSession(id)!, attemptToken: started.attemptToken!, prompt: "hello", attachments: [], config,
    engines: new Map([["claude", claudeEngine()]]), gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
  }, surface);
}

const metaOf = (id: string) => reg.getSession(id)!.transportMeta as Record<string, unknown> | null;

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  registerEmployeeAccountResolver(undefined);
});
afterEach(() => registerEmployeeAccountResolver(undefined));

describe("a turn that settles the ordinary way", () => {
  it("records the target it ran on once the session has walked a chain", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:served-own", model: "opus" });
    reg.updateSession(s.id, { transportMeta: { fallbackHops: [{ at: "2026-10-19T10:00:00.000Z", from: "a", to: "b", fromLabel: "a", toLabel: "b", reason: "rate-limit" }] } } as never);
    await runOne(s.id);

    expect(metaOf(s.id)?.fallbackServedBy).toMatchObject({ key: "claude||opus", label: "claude · opus" });
  });

  it("records the stand-in a standing run holds the session on, by the profile it runs as", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:served-standing", model: "sonnet" });
    reg.updateSession(s.id, {
      transportMeta: {
        engineOverride: { originalEngine: "claude", originalModel: "opus", originalAccount: "claude", substituteAccount: ACCOUNT_B, substituteConfigDir: DIR_B, until: "2999-01-01T00:00:00Z", syncSince: "2026-10-19T10:00:00.000Z" },
        fallbackRun: { source: "engine", position: 1, tried: ["claude||opus"], startedAt: "2026-10-19T10:00:00.000Z" },
      },
    } as never);
    await runOne(s.id);

    expect(metaOf(s.id)?.fallbackServedBy).toMatchObject({ key: "claude|B|sonnet" });
  });

  it("records nothing for a session that never walked a chain", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:served-none", model: "opus" });
    await runOne(s.id);

    expect(metaOf(s.id)?.fallbackServedBy).toBeUndefined();
  });
});

describe("a remote session on a declared remote account", () => {
  const HOST = { remoteHost: "build-host", remoteUser: "me" };
  const SPARE_DIR = "/home/me/.claude-b";
  const SPARE_KEY = `claude@me@build-host:${claudeProfileFromDir(SPARE_DIR).key}`;
  const remoteConfig = { ...config, engines: { ...config.engines, claude: { model: "opus", accounts: { spare: { ...HOST, configDir: SPARE_DIR } } } } } as unknown as JinnConfig;

  it("records the standby link by the remote account's name", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:served-remote", model: "opus" });
    const standing = { ...session, transportMeta: { engineOverride: { substituteAccount: SPARE_KEY, substituteConfigDir: SPARE_DIR }, fallbackRun: { source: "employee", position: 1, tried: ["x"], startedAt: "t" } } } as typeof session;
    const out = withServedTarget(remoteConfig, standing, {} as never);
    expect(out.transportMeta).toMatchObject({ fallbackServedBy: { key: "claude|spare|opus", label: "claude · spare · opus" } });
  });
});

describe("withServedTarget", () => {
  it("leaves fields alone for a session with nothing walked, and for no session", () => {
    const fields = { status: "idle" } as never;
    expect(withServedTarget(config, undefined, fields)).toBe(fields);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:served-unit", model: "opus" });
    expect(withServedTarget(config, session, fields)).toBe(fields);
  });

  it("builds on the meta the fields already carry", () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:served-unit-2", model: "gpt" });
    const out = withServedTarget(config, session, { transportMeta: { fallbackRun: { source: "engine", position: 1, tried: ["x"], startedAt: "t" }, kept: true } } as never);
    expect(out.transportMeta).toMatchObject({ kept: true, fallbackServedBy: { key: "codex||gpt", label: "codex · gpt" } });
  });
});
