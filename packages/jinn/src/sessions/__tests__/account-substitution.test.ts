import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Substitution tracked by account, not engine name (FR-079). A `claude` to
 * `claude:<friend>` substitute keeps the engine name, so the per-engine thread
 * slot, the profile resolver and the restore must all follow the account:
 * the original account's thread is never overwritten, a second turn inside the
 * override window runs on the substitute's profile and resumes its thread, and
 * once `until` passes the session is back on its own account and thread.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-account-substitution-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { currentClaudeAccount, sessionClaudeProfile } = await import("../session-account.js");
const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const FRIEND = "/Users/operator/.claude-friend";
const friend = claudeProfileFromDir(FRIEND);
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const third = claudeProfileFromDir("/Users/operator/.claude-third");
const THIRD_ACCOUNT = `claude:${third.key}`;
const { resolveSyncPrompt } = await import("../turn/preflight.js");
const syncPromptFor = (session: never, prompt: string) => resolveSyncPrompt(session, "claude", prompt).promptToRun;
const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" } } } as never;

function running(id: string): string {
  const token = "attempt-1";
  reg.updateSession(id, { status: "running", attemptToken: token } as never);
  return reg.getSession(id)!.attemptToken ?? token;
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  registerEmployeeAccountResolver((name) => (name === "side-dev" ? FRIEND_ACCOUNT : "claude"));
});

afterEach(() => registerEmployeeAccountResolver(undefined));

describe("a default-account session moved onto a declared account", () => {
  it("keeps its own thread, runs and resumes on the substitute, and comes back after until", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:acct-1", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "default-thread-1");
    const token = running(s.id);
    const before = reg.getSession(s.id)!;

    const sub = beginEngineSubstitution({
      session: before, attemptToken: token, config, employee: undefined, substitute: "claude",
      accounts: { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir },
      until: new Date(Date.now() + 3600_000), syncSince: new Date().toISOString(), lastError: "limit",
    });
    expect(sub?.resumeSessionId).toBeUndefined();
    // A model id belongs to one provider, and the swap stays on it.
    expect(sub?.model).toBe("opus");

    // The substitute's first turn returns its thread id; it lands in the friend's slot.
    reg.recordEngineSessionId(s.id, "claude", "friend-thread-1");
    const during = reg.getSession(s.id)!;
    expect(during.engine).toBe("claude");
    expect(currentClaudeAccount(during)).toBe(FRIEND_ACCOUNT);
    expect(sessionClaudeProfile(during, null)).toEqual(friend);
    expect(during.engineSessions?.claude?.id).toBe("default-thread-1");
    expect(during.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("friend-thread-1");

    // A second turn inside the window resumes the substitute's thread, on its profile.
    expect(maybeRevertEngineOverride(during).engineSessionId).toBe("friend-thread-1");
    expect(reg.getEngineSessionRef(during, "claude").id).toBe("friend-thread-1");

    // Past `until`, the turn-start revert hands it back.
    const meta = during.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(s.id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!);
    expect(after.engineSessionId).toBe("default-thread-1");
    expect(currentClaudeAccount(after)).toBe("claude");
    expect(sessionClaudeProfile(after, null)).toBeNull();
    expect(reg.getEngineSessionRef(after, "claude").id).toBe("default-thread-1");
    expect(after.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("friend-thread-1");
    // The original account's thread missed the substitute's turns, so it is synced.
    expect((after.transportMeta as Record<string, unknown>).claudeSyncSince).toBeTypeOf("string");
  });
});

describe("a named-profile session moved onto the default account", () => {
  it("parks its own thread under its account and runs the default account under `claude`", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:acct-2", employee: "side-dev" });
    reg.recordEngineSessionId(s.id, "claude", "friend-own-1");
    expect(reg.getSession(s.id)!.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("friend-own-1");
    const token = running(s.id);

    beginEngineSubstitution({
      session: reg.getSession(s.id)!, attemptToken: token, config, employee: { name: "side-dev", claudeConfigDir: FRIEND } as never,
      substitute: "claude", accounts: { original: FRIEND_ACCOUNT, substitute: "claude", substituteConfigDir: null },
      until: new Date(Date.now() + 3600_000), syncSince: new Date().toISOString(), lastError: "limit",
    });
    reg.recordEngineSessionId(s.id, "claude", "default-sub-1");
    const during = reg.getSession(s.id)!;
    expect(sessionClaudeProfile(during, { claudeConfigDir: FRIEND })).toBeNull();
    expect(during.engineSessions?.claude?.id).toBe("default-sub-1");
    expect(during.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("friend-own-1");
  });
});

describe("a session with no account override", () => {
  it("keeps the `claude` slot for the default account, exactly as before accounts", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:acct-3" });
    reg.recordEngineSessionId(s.id, "claude", "plain-1");
    expect(Object.keys(reg.getSession(s.id)!.engineSessions ?? {})).toEqual(["claude"]);
  });
});

function swap(id: string, accounts: { original: string; substitute: string; substituteConfigDir: string | null }, syncSince: string) {
  const token = running(id);
  return beginEngineSubstitution({
    session: reg.getSession(id)!, attemptToken: token, config, employee: undefined, substitute: "claude", accounts,
    until: new Date(Date.now() + 3600_000), syncSince, lastError: "limit",
  });
}

function expire(id: string) {
  const meta = reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>;
  reg.updateSession(id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });
}

describe("a swap while an account swap stands (the substitute was limited too)", () => {
  it("keeps the first swap's originals: back on its own account, thread and sync point", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:nested", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "a-thread");
    swap(s.id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, "2026-10-06T10:00:00.000Z");
    reg.recordEngineSessionId(s.id, "claude", "b-thread");
    const second = swap(s.id, { original: FRIEND_ACCOUNT, substitute: THIRD_ACCOUNT, substituteConfigDir: third.dir }, "2026-10-06T11:00:00.000Z");
    expect(second?.resumeSessionId).toBeUndefined();
    reg.recordEngineSessionId(s.id, "claude", "c-thread");
    expect(sessionClaudeProfile(reg.getSession(s.id)!, null)).toEqual(third);

    expire(s.id);
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!);
    expect(after.engineSessionId).toBe("a-thread");
    expect(currentClaudeAccount(after)).toBe("claude");
    const meta = after.transportMeta as Record<string, unknown>;
    expect(meta.claudeSyncSince).toBe("2026-10-06T10:00:00.000Z");
    expect(after.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("b-thread");
    expect(after.engineSessions?.[THIRD_ACCOUNT]?.id).toBe("c-thread");
  });

  it("an engine substitute taken from a substitute account still hands back the own account's thread", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:nested-engine", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "a-thread");
    swap(s.id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, "2026-10-06T10:00:00.000Z");
    reg.recordEngineSessionId(s.id, "claude", "b-thread");
    beginEngineSubstitution({
      session: reg.getSession(s.id)!, attemptToken: running(s.id), config, employee: undefined, substitute: "codex",
      until: new Date(Date.now() + 3600_000), syncSince: "2026-10-06T11:00:00.000Z", lastError: "limit",
    });
    expect(currentClaudeAccount(reg.getSession(s.id)!)).toBe("claude");
    expire(s.id);
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!);
    expect(after.engine).toBe("claude");
    expect(after.engineSessionId).toBe("a-thread");
    expect((after.transportMeta as Record<string, unknown>).claudeSyncSince).toBe("2026-10-06T10:00:00.000Z");
  });
});

describe("an engine switch while an account swap stands", () => {
  it("parks the substitute's thread under its account and returns to the own account's thread", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:switch", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "a-thread");
    swap(s.id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, new Date().toISOString());
    reg.recordEngineSessionId(s.id, "claude", "b-thread");
    reg.updateSession(s.id, { status: "idle" } as never);
    reg.switchSessionEngine(s.id, "codex");
    const back = reg.switchSessionEngine(s.id, "claude")!;
    expect(back.engineSessionId).toBe("a-thread");
    expect(back.engineSessions?.claude?.id).toBe("a-thread");
    expect(back.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("b-thread");
    expect(sessionClaudeProfile(back, null)).toBeNull();
  });
});

describe("rows written before Claude's slot was keyed by account", () => {
  it("still find a named-profile employee's own thread under `claude`", () => {
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:legacy", employee: "side-dev" });
    reg.updateSession(s.id, { engineSessions: { claude: { id: "old-claude-thread" }, codex: { id: "c1" } }, engineSessionId: "c1" } as never);
    expect(reg.getEngineSessionRef(reg.getSession(s.id)!, "claude").id).toBe("old-claude-thread");
    const back = reg.switchSessionEngine(s.id, "claude")!;
    expect(back.engineSessionId).toBe("old-claude-thread");
    expect(back.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("old-claude-thread");
  });

  it("stop reading `claude` once the row has an account-keyed slot", () => {
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:legacy-done", employee: "side-dev" });
    reg.updateSession(s.id, { engineSessions: { claude: { id: "default-sub" }, [FRIEND_ACCOUNT]: { model: "opus" }, codex: { id: "c1" } }, engineSessionId: "c1" } as never);
    expect(reg.getEngineSessionRef(reg.getSession(s.id)!, "claude").id).toBeUndefined();
  });
});

describe("the sync intro after an account swap", () => {
  it("says another Claude account, not GPT", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:intro", model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "a-thread");
    swap(s.id, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir }, new Date(Date.now() - 60_000).toISOString());
    expire(s.id);
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!);
    expect(syncPromptFor(after as never, "hello")).toMatch(/^We temporarily ran this session on another Claude account due to a usage limit\./);
  });
});
