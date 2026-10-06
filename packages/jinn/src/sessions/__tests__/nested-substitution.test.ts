import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A swap made while an override already stands: the substitute was limited too.
 * Whatever the first swap moved the session off, engine or account, is what it
 * goes back to, so the record keeps the first swap's engine, account, thread,
 * model, sync point and window, and only the substitute it names is replaced.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-nested-substitution-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { beginEngineSubstitution, maybeRevertEngineOverride } = await import("../engine-override.js");
const { accountOverride, currentClaudeAccount } = await import("../session-account.js");
const { registerEmployeeAccountResolver } = await import("../../shared/engine-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const friend = claudeProfileFromDir(path.join(tmp, ".claude-friend"));
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" } } } as never;

const HOUR = 3600_000;
const FIRST_SYNC = "2026-10-06T10:00:00.000Z";

function running(id: string): string {
  reg.updateSession(id, { status: "running", attemptToken: "attempt-1" } as never);
  return reg.getSession(id)!.attemptToken ?? "attempt-1";
}

function swap(id: string, substitute: string, until: Date, syncSince: string, accounts?: { original: string; substitute: string; substituteConfigDir: string | null }) {
  return beginEngineSubstitution({
    session: reg.getSession(id)!, attemptToken: running(id), config, employee: undefined, substitute, accounts, until, syncSince, lastError: "limit",
  });
}

function record(id: string): Record<string, unknown> {
  return (reg.getSession(id)!.transportMeta as Record<string, Record<string, unknown>>).engineOverride;
}

/** A Claude session on its own account and thread, pinned to opus. */
function claudeSession(ref: string): string {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: ref, model: "opus" });
  reg.recordEngineSessionId(s.id, "claude", "claude-thread");
  return s.id;
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  registerEmployeeAccountResolver(() => "claude");
});

afterEach(() => {
  registerEmployeeAccountResolver(undefined);
  vi.useRealTimers();
});

describe("an engine swap while an engine swap stands (claude → codex, then codex limited → pi)", () => {
  it("keeps claude's engine, thread, model, sync point and window, and names pi only as the substitute", () => {
    const id = claudeSession("web:nested-engines");
    const firstUntil = new Date(Date.now() + HOUR);
    swap(id, "codex", firstUntil, FIRST_SYNC);
    reg.recordEngineSessionId(id, "codex", "codex-thread");

    swap(id, "pi", new Date(Date.now() + 5 * HOUR), "2026-10-06T11:00:00.000Z");

    const now = reg.getSession(id)!;
    expect(now.engine).toBe("pi");
    expect(now.engineSessions?.codex?.id).toBe("codex-thread");
    expect(record(id)).toEqual({
      originalEngine: "claude",
      originalEngineSessionId: "claude-thread",
      originalModel: "opus",
      until: firstUntil.toISOString(),
      syncSince: FIRST_SYNC,
    });
  });

  it("goes back to claude at the first swap's until, on its thread and pin, synced from the first swap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const id = claudeSession("web:nested-engines-revert");
    swap(id, "codex", new Date(start.getTime() + HOUR), FIRST_SYNC);
    reg.recordEngineSessionId(id, "codex", "codex-thread");
    // Codex's own window outlasts claude's: the session must not wait for it.
    swap(id, "pi", new Date(start.getTime() + 5 * HOUR), "2026-10-06T10:30:00.000Z");
    reg.recordEngineSessionId(id, "pi", "pi-thread");

    vi.setSystemTime(new Date(start.getTime() + 2 * HOUR));
    const after = maybeRevertEngineOverride(reg.getSession(id)!);
    expect(after.engine).toBe("claude");
    expect(after.engineSessionId).toBe("claude-thread");
    expect(after.model).toBe("opus");
    const meta = after.transportMeta as Record<string, unknown>;
    expect(meta.engineOverride).toBeUndefined();
    expect(meta.claudeSyncSince).toBe(FIRST_SYNC);
    expect(meta.claudeSyncAccount).toBeUndefined();
    expect(after.engineSessions?.codex?.id).toBe("codex-thread");
    expect(after.engineSessions?.pi?.id).toBe("pi-thread");
  });
});

describe("a chain that hands the turn back to the limited engine (claude → codex, then codex limited → claude)", () => {
  it("stays on claude's newest thread at the revert and catches it up on the codex turns, as an engine swap", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const id = claudeSession("web:hand-back");
    swap(id, "codex", new Date(start.getTime() + HOUR), FIRST_SYNC);
    reg.recordEngineSessionId(id, "codex", "codex-thread");
    // Every member is exhausted, so the chain's second pass hands the turn back to claude.
    const back = swap(id, "claude", new Date(start.getTime() + 5 * HOUR), "2026-10-06T10:30:00.000Z");
    expect(back?.resumeSessionId).toBe("claude-thread");
    reg.recordEngineSessionId(id, "claude", "claude-thread-2");

    vi.setSystemTime(new Date(start.getTime() + 2 * HOUR));
    const after = maybeRevertEngineOverride(reg.getSession(id)!);
    expect(after.engine).toBe("claude");
    expect(after.engineSessionId).toBe("claude-thread-2");
    expect(after.engineSessions?.claude?.id).toBe(after.engineSessionId);
    expect(after.model).toBe("opus");
    const meta = after.transportMeta as Record<string, unknown>;
    expect(meta.claudeSyncSince).toBe(FIRST_SYNC);
    expect(meta.claudeSyncAccount).toBeUndefined();
    expect(after.engineSessions?.codex?.id).toBe("codex-thread");
  });
});

describe("an engine swap while an account swap's engine swap stands (account → codex → pi)", () => {
  it("goes back to claude on its own account and thread, not to codex", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-10-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const id = claudeSession("web:account-engine-engine");
    const firstUntil = new Date(start.getTime() + HOUR);
    swap(id, "claude", firstUntil, FIRST_SYNC, { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir });
    reg.recordEngineSessionId(id, "claude", "friend-thread");
    swap(id, "codex", new Date(start.getTime() + 3 * HOUR), "2026-10-06T10:20:00.000Z");
    reg.recordEngineSessionId(id, "codex", "codex-thread");

    swap(id, "pi", new Date(start.getTime() + 5 * HOUR), "2026-10-06T10:40:00.000Z");
    expect(record(id)).toEqual({
      originalEngine: "claude",
      originalEngineSessionId: "claude-thread",
      originalModel: "opus",
      until: firstUntil.toISOString(),
      syncSince: FIRST_SYNC,
    });

    vi.setSystemTime(new Date(start.getTime() + 2 * HOUR));
    const after = maybeRevertEngineOverride(reg.getSession(id)!);
    expect(after.engine).toBe("claude");
    expect(after.engineSessionId).toBe("claude-thread");
    expect(after.model).toBe("opus");
    expect(currentClaudeAccount(after)).toBe("claude");
    expect((after.transportMeta as Record<string, unknown>).claudeSyncSince).toBe(FIRST_SYNC);
    expect(after.engineSessions?.[FRIEND_ACCOUNT]?.id).toBe("friend-thread");
  });
});

describe("an account swap while an engine swap stands (codex → claude, then claude limited → another account)", () => {
  it("keeps codex as the engine to go back to, and names the account claude left", () => {
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:engine-account", model: "gpt-5.6-sol" });
    reg.recordEngineSessionId(s.id, "codex", "codex-thread");
    const firstUntil = new Date(Date.now() + HOUR);
    swap(s.id, "claude", firstUntil, FIRST_SYNC);
    reg.recordEngineSessionId(s.id, "claude", "claude-thread");

    swap(s.id, "claude", new Date(Date.now() + 5 * HOUR), "2026-10-06T11:00:00.000Z",
      { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir });

    expect(record(s.id)).toMatchObject({
      originalEngine: "codex",
      originalEngineSessionId: "codex-thread",
      originalModel: "gpt-5.6-sol",
      until: firstUntil.toISOString(),
      syncSince: FIRST_SYNC,
    });
    expect(accountOverride(reg.getSession(s.id)!)).toEqual({ originalAccount: "claude", substituteAccount: FRIEND_ACCOUNT, substituteConfigDir: friend.dir });
  });
});
