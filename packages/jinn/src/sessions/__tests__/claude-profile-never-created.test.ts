import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig } from "../../shared/types.js";

/**
 * The gateway never creates a named Claude profile's directory (FR-054). Claude Code
 * itself makes its config dir on first run, even for `claude auth status`, and a
 * stray directory turns the "does not exist" refusal into "not signed in" while
 * littering the operator's home for any mistyped `claudeConfigDir`.
 *
 * The stand-in CLI below does what the real one does: it creates `$CLAUDE_CONFIG_DIR`.
 * Every path that launches it under a profile, or writes inside one, has to check
 * the directory first.
 */

vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

let ROOT: string;
let MISSING: string;
let FAKE_CLAUDE: string;

const cfg = (): JinnConfig => ({
  gateway: { port: 7799, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: FAKE_CLAUDE, model: "opus" } },
  models: { claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: ["low"] }] } },
  connectors: {},
}) as unknown as JinnConfig;

let seq = 0;
/** A profile directory that does not exist, distinct per call so one test cannot create another's. */
const freshMissing = () => path.join(ROOT, "host", `.claude-gone-${seq++}`);

const sideMissing = () => ({ name: "side-missing", engine: "claude", claudeConfigDir: MISSING }) as Employee;

beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-profile-never-created-")));
  MISSING = path.join(ROOT, "host", ".claude-gone");
  fs.mkdirSync(path.join(ROOT, "home", "tmp", "engine-limits", "claude"), { recursive: true });
  FAKE_CLAUDE = path.join(ROOT, "claude");
  fs.writeFileSync(FAKE_CLAUDE, [
    "#!/bin/sh",
    '[ -n "$CLAUDE_CONFIG_DIR" ] && mkdir -p "$CLAUDE_CONFIG_DIR"',
    "echo '{\"loggedIn\":false,\"authMethod\":\"none\"}'",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  process.env.JINN_HOME = path.join(ROOT, "home");
  fs.mkdirSync(path.dirname(MISSING), { recursive: true });
});

afterAll(() => {
  delete process.env.JINN_HOME;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("a missing named profile directory stays missing", () => {
  it("after a limits refresh and a full turn attempt, and the refusal says it does not exist", async () => {
    const limits = await import("../../shared/engine-limits.js");
    const accounts = await import("../../shared/engine-limits-accounts.js");
    const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
    accounts.registerAccountRoster(() => [sideMissing()]);

    const res = await limits.collectEngineLimits(cfg(), { engine: "claude" });
    const account = res.accounts?.claude?.find((a) => a.account === `claude:${claudeProfileFromDir(MISSING).key}`);
    expect(account).toBeDefined();
    expect(fs.existsSync(MISSING)).toBe(false);

    const { preflightTurn } = await import("../turn/preflight.js");
    const engine = { run: vi.fn() };
    const result = preflightTurn({
      session: { id: "s1", engine: "claude", source: "web", employee: "side-missing" } as any,
      attemptToken: "t1",
      prompt: "hi",
      attachments: [],
      employee: sideMissing(),
      config: cfg(),
      engines: new Map([["claude", engine as any]]),
      gatewayBootId: "b",
      connectorNames: [],
      channel: "web",
      user: "web-user",
    } as any);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("does not exist") });
    expect(result).not.toMatchObject({ error: expect.stringContaining("not signed in") });
    expect(fs.existsSync(MISSING)).toBe(false);
    accounts.registerAccountRoster(() => []);
  });

  it("folder trust is not seeded into it", async () => {
    const { ensureClaudeProfileTrust, resetClaudeProfileTrustForTests } = await import("../../engines/claude-profile-launch.js");
    const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
    const missing = freshMissing();
    resetClaudeProfileTrustForTests();
    ensureClaudeProfileTrust(claudeProfileFromDir(missing), ROOT);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("seedTrust leaves the directory alone when told not to create it", async () => {
    const { seedTrust } = await import("../../shared/claude-settings.js");
    const missing = freshMissing();
    expect(() => seedTrust(path.join(missing, ".claude.json"), ROOT, { createDir: false })).toThrow(/ENOENT/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("a fork is refused before the CLI is launched", async () => {
    const { forkClaudeSession } = await import("../fork.js");
    const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
    const missing = freshMissing();
    await expect(forkClaudeSession({ engineSessionId: "abc", cwd: ROOT, claudeProfile: claudeProfileFromDir(missing) }))
      .rejects.toThrow(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("an existing profile directory is still seeded", async () => {
    const present = path.join(ROOT, "host", ".claude-present");
    fs.mkdirSync(present);
    const { ensureClaudeProfileTrust, resetClaudeProfileTrustForTests } = await import("../../engines/claude-profile-launch.js");
    const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");
    resetClaudeProfileTrustForTests();
    ensureClaudeProfileTrust(claudeProfileFromDir(present), ROOT);
    expect(JSON.parse(fs.readFileSync(path.join(present, ".claude.json"), "utf8")).hasCompletedOnboarding).toBe(true);
  });
});
