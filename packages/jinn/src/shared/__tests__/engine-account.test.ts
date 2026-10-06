import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-account state for local named Claude profiles (FR-055, SC-006): a named
 * profile's limit, rate-limit memory and status-line snapshots never move the
 * default account's reading, and the default account's limit never moves a
 * named profile's sessions.
 */

vi.mock("../models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../models.js")>()),
  engineAvailable: () => true,
  getModelRegistry: vi.fn(() => ({ claude: { available: true }, codex: { available: true } })),
}));
vi.mock("../engine-limits-claude.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engine-limits-claude.js")>()),
  fetchClaudeOAuthUsage: vi.fn(async () => undefined),
}));

import {
  accountForEmployee,
  claudeAccountKey,
  isDefaultAccountSession,
  registerSessionAccountResolver,
} from "../engine-account.js";
import { claudeProfileFromDir } from "../claude-profile.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit, readClaudeUsageState, recordClaudeRateLimit } from "../usageAwareness.js";
import { isEngineExhausted, readEngineHealth, recordEngineUnavailable } from "../engine-health.js";
import { claudeSnapshotFile } from "../engine-limits-claude.js";
import { claudeResetsAtSeconds } from "../engine-reset-times.js";
import { CLAUDE_LIMITS_DIR, JINN_HOME } from "../paths.js";
import { newSessionEngineSelection } from "../../sessions/new-session-engine.js";
import { validateNewSessionSelection } from "../../sessions/session-patch.js";
import { resetOrgRegistryForTests } from "../../gateway/org-registry.js";
import { newestOperatorStatuslineMtime } from "../../board-walk/snapshot.js";
import { claudeAuthScope, refuseClaudeLaunch } from "../../sessions/claude-auth-watch.js";
import { claudeAuthFailureAlert } from "../claude-auth-messages.js";
import type { Employee, JinnConfig, Session } from "../types.js";

const FRIEND = "/Users/operator/.claude-friend";
const friend = claudeProfileFromDir(FRIEND);
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const local = (extra: Partial<Employee> = {}) => ({ name: "e", engine: "claude", ...extra }) as Employee;

function clearState(): void {
  fs.rmSync(path.join(JINN_HOME, "tmp"), { recursive: true, force: true });
}

beforeEach(clearState);
afterEach(() => {
  registerSessionAccountResolver(undefined);
  clearState();
});

describe("account keys (FR-070)", () => {
  it("keep `claude` for the default profile and every remote employee, and key a local named profile", () => {
    expect(claudeAccountKey(null)).toBe("claude");
    expect(accountForEmployee(undefined)).toBe("claude");
    expect(accountForEmployee(local())).toBe("claude");
    expect(accountForEmployee(local({ claudeConfigDir: FRIEND }))).toBe(FRIEND_ACCOUNT);
    expect(accountForEmployee(local({ remoteHost: "box", remoteClaudeConfigDir: "/h/.c" }))).toBe("claude");
    expect(accountForEmployee(local({ claudeConfigDir: FRIEND }), "codex")).toBe("codex");
  });
});

describe("the rate-limit memory is per account", () => {
  it("a named profile's limit leaves the default account's memory untouched, and the reverse", () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    recordClaudeRateLimit(reset, FRIEND_ACCOUNT);
    expect(isLikelyNearClaudeUsageLimit(new Date(), FRIEND_ACCOUNT)).toBe(true);
    expect(getClaudeExpectedResetAt(new Date(), FRIEND_ACCOUNT)?.getTime()).toBe(reset * 1000);
    expect(isLikelyNearClaudeUsageLimit()).toBe(false);
    expect(getClaudeExpectedResetAt()).toBeUndefined();

    recordClaudeRateLimit(reset + 60);
    expect(getClaudeExpectedResetAt()?.getTime()).toBe((reset + 60) * 1000);
    expect(getClaudeExpectedResetAt(new Date(), FRIEND_ACCOUNT)?.getTime()).toBe(reset * 1000);
  });

  it("keeps the default account's record at the file's top level, as before accounts", () => {
    recordClaudeRateLimit(1_900_000_000);
    const file = JSON.parse(fs.readFileSync(path.join(JINN_HOME, "tmp", "claude-usage.json"), "utf-8"));
    expect(file.lastResetsAt).toBe(new Date(1_900_000_000_000).toISOString());
    expect(file).not.toHaveProperty("accounts");
    expect(readClaudeUsageState(FRIEND_ACCOUNT)).toEqual({});
  });
});

describe("SC-006: two profiles with independent limits", () => {
  const config = { engines: { default: "claude", claude: { fallback: ["codex"] }, codex: {} } } as unknown as JinnConfig;
  const engines = new Map([["claude", {}], ["codex", {}]]) as any;
  const startsOn = (employee: Employee) => newSessionEngineSelection(config, engines, { employee }).engine;
  const until = () => Math.floor(Date.now() / 1000) + 3600;

  it("the named account at its limit: the default account's sessions still start on claude", () => {
    recordEngineUnavailable(FRIEND_ACCOUNT, "Claude usage limit", until());
    expect(isEngineExhausted(readEngineHealth(), FRIEND_ACCOUNT)).toBe(true);
    expect(isEngineExhausted(readEngineHealth(), "claude")).toBe(false);
    expect(startsOn(local())).toBe("claude");
  });

  it("the default account at its limit: the named profile's sessions still start on claude", () => {
    recordEngineUnavailable("claude", "Claude usage limit", until());
    expect(startsOn(local())).toBe("codex");
    expect(startsOn(local({ claudeConfigDir: FRIEND }))).toBe("claude");
  });
});

describe("a session started for an employee by name (validateNewSessionSelection)", () => {
  const orgDir = path.join(JINN_HOME, "org", "eng");
  afterEach(() => {
    fs.rmSync(path.join(JINN_HOME, "org"), { recursive: true, force: true });
    resetOrgRegistryForTests();
  });

  it("is not moved off claude for a named profile while the default account is at its limit", () => {
    fs.mkdirSync(orgDir, { recursive: true });
    fs.writeFileSync(path.join(orgDir, "side-dev.yaml"), `name: side-dev\npersona: p\nclaudeConfigDir: ${FRIEND}\n`);
    fs.writeFileSync(path.join(orgDir, "eng-dev.yaml"), "name: eng-dev\npersona: p\n");
    resetOrgRegistryForTests();
    const config = { engines: { default: "claude", claude: { fallback: ["codex"] }, codex: {} } } as unknown as JinnConfig;
    recordEngineUnavailable("claude", "Claude usage limit", Math.floor(Date.now() / 1000) + 3600);
    expect(validateNewSessionSelection(config, {}, { engine: "claude", employee: "eng-dev" }).engine).toBe("codex");
    expect(validateNewSessionSelection(config, {}, { engine: "claude", employee: "side-dev" }).engine).toBe("claude");
  });
});

describe("the default reading stays the default account's (FR-055)", () => {
  function snapshot(sessionId: string, mtimeSec: number, resetsAt: number): void {
    fs.mkdirSync(CLAUDE_LIMITS_DIR, { recursive: true });
    const file = path.join(CLAUDE_LIMITS_DIR, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({
      jinn_session_id: sessionId,
      rate_limits: { five_hour: { used_percentage: 40, resets_at: resetsAt } },
    }));
    fs.utimesSync(file, mtimeSec, mtimeSec);
  }

  beforeEach(() => {
    registerSessionAccountResolver((id) => (id === "friend-session" ? FRIEND_ACCOUNT : "claude"));
  });

  it("a newer named-profile snapshot changes neither the Limits reading nor the reset time", async () => {
    const now = Math.floor(Date.now() / 1000);
    snapshot("operator-session", now - 600, now + 3600);
    snapshot("friend-session", now - 10, now + 7200);
    expect(path.basename(claudeSnapshotFile(CLAUDE_LIMITS_DIR)!)).toBe("operator-session.json");
    expect(await claudeResetsAtSeconds()).toBe(now + 3600);
    expect(isDefaultAccountSession("friend-session")).toBe(false);
  });

  it("the board walk's sighting of the operator's CLI ignores a named profile's snapshot", () => {
    const now = Math.floor(Date.now() / 1000);
    snapshot("operator-session", now - 600, now + 3600);
    snapshot("friend-session", now - 10, now + 7200);
    const sessions = [{ id: "operator-session" }, { id: "friend-session" }] as Session[];
    expect(newestOperatorStatuslineMtime(sessions)).toBe((now - 600) * 1000);
  });

  it("with nothing registered every snapshot is the default account's, as before accounts", () => {
    registerSessionAccountResolver(undefined);
    const now = Math.floor(Date.now() / 1000);
    snapshot("operator-session", now - 600, now + 3600);
    snapshot("friend-session", now - 10, now + 7200);
    expect(path.basename(claudeSnapshotFile(CLAUDE_LIMITS_DIR)!)).toBe("friend-session.json");
  });
});

describe("the auth outage ledger is per account", () => {
  it("scopes a named profile as `local:<key>`, leaving `local` for the default", () => {
    expect(claudeAuthScope(local())).toBe("local");
    expect(claudeAuthScope(local({ claudeConfigDir: FRIEND }))).toBe(`local:${friend.key}`);
    expect(claudeAuthScope(local({ remoteHost: "box", remoteUser: "b" }))).toBe("b@box");
  });

  it("refuses a turn on a named profile that is not signed in, naming the login command (FR-054)", () => {
    const missing = path.join(JINN_HOME, "..", "no-such-claude-profile");
    expect(refuseClaudeLaunch(local({ claudeConfigDir: missing }))).toBe(
      `The Claude profile ${missing} does not exist. To sign it in on this machine, run \`CLAUDE_CONFIG_DIR=${missing} claude\`, then \`/login\`.`,
    );
  });

  it("tells the operator to sign that profile in, not to log the gateway in", () => {
    const outage = { since: "2026-10-06T00:00:00.000Z", failures: 1, skipped: 0, lastReason: "authentication_failed" } as any;
    const alert = claudeAuthFailureAlert(`local:${friend.key}`, outage, undefined, "mac");
    expect(alert).toContain(`the Claude profile ${friend.key} on the gateway host (mac)`);
    expect(alert).toContain("CLAUDE_CONFIG_DIR=<that employee's claudeConfigDir> claude");
    expect(alert).not.toContain("claude auth login");
  });
});
