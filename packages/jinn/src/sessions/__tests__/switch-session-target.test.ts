import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * `switchSessionTarget`: the one write behind every switch of a session's engine, Claude
 * profile, model or effort. Each case names a guard in it and fails without that line.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-switch-session-target-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { maybeRevertEngineOverride } = await import("../engine-override-revert.js");
const { resolveSyncPrompt, resolveTurnPrompt } = await import("../turn/preflight.js");
const { mergeTransportMeta } = await import("../manager.js");
const { claudeAccountKey } = await import("../../shared/engine-account.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const WORK = "/profiles/work";
const WORK_ACCOUNT = claudeAccountKey(claudeProfileFromDir(WORK));
const run = { source: "engine", position: 1, tried: ["claude||opus"], startedAt: "2026-10-19T10:00:00.000Z" };
const hops = [{ at: "2026-10-19T10:00:00.000Z", from: "claude||opus", to: "codex||", fromLabel: "claude · opus", toLabel: "codex", reason: "rate-limit" }];

const metaOf = (id: string) => reg.getSession(id)!.transportMeta as Record<string, unknown>;

function claudeSession(ref: string, thread = "own-thread") {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: ref, model: "opus" });
  reg.recordEngineSessionId(s.id, "claude", thread);
  return reg.getSession(s.id)!;
}

function dbValue(id: string): string | null {
  const row = reg.getSession(id);
  return row?.claudeConfigDir ?? null;
}

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("the left conversation", () => {
  it("is parked under its own account, and a return to that profile resumes its id", () => {
    const s = claudeSession("web:park");

    const away = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" })!;
    expect(away.claudeConfigDir).toBe(WORK);
    expect(away.engineSessionId).toBeNull();
    expect(away.engineSessions?.claude?.id).toBe("own-thread");

    const back = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: null })!;
    expect(back.claudeConfigDir).toBeNull();
    expect(back.engineSessionId).toBe("own-thread");
  });

  it("keeps each profile's own thread when the session moves between three targets", () => {
    const s = claudeSession("web:three");
    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });
    reg.recordEngineSessionId(s.id, "claude", "work-thread");
    const onCodex = reg.switchSessionTarget(s.id, { engine: "codex" })!;
    expect(onCodex.claudeConfigDir).toBe(WORK);
    expect(onCodex.engineSessions?.[WORK_ACCOUNT]?.id).toBe("work-thread");
    expect(onCodex.engineSessions?.claude?.id).toBe("own-thread");
  });

  it("is dropped when it is retired, so a return starts a fresh conversation", () => {
    const s = claudeSession("web:retire");

    const away = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus", leftConversation: "retire" })!;
    expect(away.engineSessions?.claude).toBeUndefined();

    const back = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: null })!;
    expect(back.engineSessionId).toBeNull();
  });

  it("leaves the profile alone when the request names none, and clears it for own login", () => {
    const s = claudeSession("web:keep-dir");
    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });

    reg.switchSessionTarget(s.id, { engine: "codex" });
    expect(dbValue(s.id)).toBe(WORK);

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: null });
    expect(dbValue(s.id)).toBeNull();
  });
});

describe("a move to another Claude account", () => {
  it("is refused without a model, because an empty slot would leave the row reading as a pre-account one", () => {
    const s = claudeSession("web:no-model");

    expect(() => reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK })).toThrow(/needs a model/);

    expect(reg.getSession(s.id)!.claudeConfigDir).toBeNull();
  });

  it("does not hand the left account's thread to the new account, and keeps it after the new thread is recorded", () => {
    const s = claudeSession("web:not-legacy");

    const away = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" })!;
    expect(away.engineSessionId).toBeNull();
    reg.recordEngineSessionId(s.id, "claude", "work-thread");

    const after = reg.getSession(s.id)!;
    expect(after.engineSessions?.claude?.id).toBe("own-thread");
    expect(after.engineSessions?.[WORK_ACCOUNT]?.id).toBe("work-thread");
  });

  it("re-keys a pre-account row's thread to the account it belongs to, so the new account never inherits it", () => {
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:legacy", model: "gpt-5.5", claudeConfigDir: "/profiles/side" });
    reg.updateSession(s.id, { engineSessions: { claude: { id: "side-thread" }, codex: { id: "c1" } }, engineSessionId: "c1" } as never);

    const away = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" })!;

    expect(away.engineSessionId).toBeNull();
    expect(away.engineSessions?.[claudeAccountKey(claudeProfileFromDir("/profiles/side"))]?.id).toBe("side-thread");
    expect(away.engineSessions?.claude).toBeUndefined();
  });
});

describe("what the switch clears", () => {
  it("ends the engine override and the fallback run and keeps the hops", () => {
    const s = claudeSession("web:override");
    const standing = { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z", syncSince: "2026-10-19T10:00:00.000Z" };
    reg.updateSession(s.id, { transportMeta: { engineOverride: standing, fallbackRun: run, fallbackHops: hops } } as never);

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });

    expect(metaOf(s.id).engineOverride).toBeUndefined();
    expect(metaOf(s.id).fallbackRun).toBeUndefined();
    expect(metaOf(s.id).fallbackHops).toEqual(hops);
  });

  it.each([
    ["claudeSyncSince", { claudeSyncSince: "2026-10-19T10:00:00.000Z" }],
    ["claudeSyncAccount", { claudeSyncSince: "2026-10-19T10:00:00.000Z", claudeSyncAccount: true }],
    ["the lost-conversation key", { lostConversationEngine: "claude" }],
    ["a pointer marker of an earlier switch", { engineSyncTarget: "claude", engineSyncSince: "2026-10-19T10:00:00.000Z", engineSyncMode: "pointer" }],
  ])("drops %s, so nothing pre-empts the new conversation's first prompt", (_name, stale) => {
    const s = claudeSession("web:stale");
    reg.updateSession(s.id, { transportMeta: stale } as never);

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus", sync: "none" });

    const meta = metaOf(s.id);
    for (const key of Object.keys(stale)) expect(meta[key], key).toBeUndefined();
  });

  it("drops a pending session switch and writes the record it was handed", () => {
    const s = claudeSession("web:pending");
    reg.updateSession(s.id, { transportMeta: { pendingSwitch: { claimedAt: 1 } } } as never);

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus", lastSwitch: { by: "operator", applied: true } });

    expect(metaOf(s.id).pendingSwitch).toBeUndefined();
    expect(metaOf(s.id).lastSwitch).toEqual({ by: "operator", applied: true });
  });

  it("clears the context meter and the error, and leaves the session idle", () => {
    const s = claudeSession("web:idle");
    reg.updateSession(s.id, { status: "error", lastError: "boom", lastContextTokens: 9000 });

    const after = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" })!;

    expect(after.status).toBe("idle");
    expect(after.lastError).toBeNull();
    expect(after.lastContextTokens).toBeNull();
  });
});

describe("the history pointer marker", () => {
  it("is what the first prompt follows even when a lost-conversation marker stood before the switch", () => {
    const s = claudeSession("web:lost-first");
    reg.updateSession(s.id, { transportMeta: { lostConversationEngine: "claude" } } as never);

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });

    const plan = resolveTurnPrompt(reg.getSession(s.id)!, "claude", "first on work", false);
    expect(plan.promptToRun).toContain("read_session");
    expect(plan.promptToRun).not.toMatch(/could not be resumed/);
  });

  it("is set for a move to another conversation slot, in pointer mode", () => {
    const s = claudeSession("web:marker");

    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });

    expect(metaOf(s.id)).toMatchObject({ engineSyncTarget: "claude", engineSyncMode: "pointer" });
    expect(typeof metaOf(s.id).engineSyncSince).toBe("string");
  });

  it("tells a return to the parked conversation when it was left, and a first visit that it starts fresh", () => {
    const s = claudeSession("web:return");
    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });
    const first = resolveSyncPrompt(reg.getSession(s.id)!, "claude", "on work").promptToRun;
    expect(first).toMatch(/starts without the earlier history/);

    const back = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: null })!;
    const since = (back.transportMeta as Record<string, unknown>).engineSyncSince as string;
    const prompt = resolveSyncPrompt(back, "claude", "home again").promptToRun;

    expect(back.engineSessionId).toBe("own-thread");
    expect(prompt).toContain(`which has been away since ${since}`);
    expect(prompt).not.toMatch(/starts without the earlier history/);
  });

  it("is not set when the switch carries its own prompt (sync: none)", () => {
    const s = claudeSession("web:sync-none");

    reg.switchSessionTarget(s.id, { engine: "codex", sync: "none" });

    expect(metaOf(s.id).engineSyncTarget).toBeUndefined();
    expect(metaOf(s.id).engineSyncMode).toBeUndefined();
  });

  it("is not set when only the model changes and the conversation stays where it is", () => {
    const s = claudeSession("web:model-only");

    const after = reg.switchSessionTarget(s.id, { engine: "claude", model: "sonnet" })!;

    expect(after.model).toBe("sonnet");
    expect(after.engineSessionId).toBe("own-thread");
    expect(metaOf(s.id).engineSyncMode).toBeUndefined();
  });

  it("gives way to the pasted catch-up when an override revert writes its own marker", () => {
    const s = claudeSession("web:revert");
    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });
    expect(metaOf(s.id).engineSyncMode).toBe("pointer");
    // The session then stood on a stand-in for codex, which it never had a thread on, and the window ended.
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const override = { originalEngine: "codex", originalModel: "gpt-5.5", until: new Date(Date.now() - 1000).toISOString(), syncSince: since };
    reg.updateSession(s.id, { transportMeta: { ...metaOf(s.id), engineOverride: override } } as never);

    const reverted = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect(reverted.engine).toBe("codex");
    expect((reverted.transportMeta as Record<string, unknown>).engineSyncMode).toBeUndefined();
    expect(resolveSyncPrompt(reverted, "codex", "hello").promptToRun).toMatch(/^We switched engines in this Jinn session\./);
  });

  it("gives way to the pasted catch-up when the revert hands claude back its own marker", () => {
    const s = claudeSession("web:revert-claude");
    reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus" });
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const override = { originalEngine: "claude", originalModel: "opus", until: new Date(Date.now() - 1000).toISOString(), syncSince: since };
    reg.updateSession(s.id, { transportMeta: { ...metaOf(s.id), engineOverride: override } } as never);

    const reverted = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect((reverted.transportMeta as Record<string, unknown>).claudeSyncSince).toBe(since);
    expect((reverted.transportMeta as Record<string, unknown>).engineSyncMode).toBeUndefined();
  });
});

describe("a switch applied inside the turn that asked", () => {
  function running(id: string): string {
    return reg.beginSessionAttempt(id)!.attemptToken!;
  }

  it("leaves the session running with its error alone, so that turn's settle still lands", () => {
    const s = claudeSession("web:fenced");
    const token = running(s.id);
    reg.updateSession(s.id, { lastError: "kept" });

    const switched = reg.switchSessionTarget(s.id, { engine: "claude", claudeConfigDir: WORK, model: "opus", sync: "none" }, { attemptToken: token })!;

    expect(switched.status).toBe("running");
    expect(switched.lastError).toBe("kept");
    expect(switched.claudeConfigDir).toBe(WORK);
    const settled = reg.completeSessionAttempt(s.id, token, { status: "idle", lastError: null });
    expect(settled?.status).toBe("idle");
  });

  it("writes nothing for a stale attempt, the profile column included", () => {
    const s = claudeSession("web:stale-token");
    const stale = running(s.id);
    running(s.id); // a newer turn took the session

    const result = reg.switchSessionTarget(s.id, { engine: "codex", claudeConfigDir: WORK, model: "opus" }, { attemptToken: stale });

    expect(result).toBeUndefined();
    const row = reg.getSession(s.id)!;
    expect(row.engine).toBe("claude");
    expect(row.claudeConfigDir).toBeNull();
    expect(row.engineSessionId).toBe("own-thread");
  });

  it("writes nothing when the session is no longer running", () => {
    const s = claudeSession("web:not-running");
    const token = running(s.id);
    reg.updateSession(s.id, { status: "interrupted" });

    expect(reg.switchSessionTarget(s.id, { engine: "codex" }, { attemptToken: token })).toBeUndefined();
    expect(reg.getSession(s.id)!.engine).toBe("claude");
  });
});

describe("adapter merges", () => {
  it("cannot overwrite the pointer mode, the pending switch or the last switch", () => {
    const existing = { engineSyncMode: "pointer", pendingSwitch: { claimedAt: 1 }, lastSwitch: { by: "operator" }, other: 1 };

    const merged = mergeTransportMeta(
      existing as never,
      { engineSyncMode: "transcript", pendingSwitch: { claimedAt: 2 }, lastSwitch: null, other: 2 } as never,
    ) as Record<string, unknown>;

    expect(merged.engineSyncMode).toBe("pointer");
    expect(merged.pendingSwitch).toEqual({ claimedAt: 1 });
    expect(merged.lastSwitch).toEqual({ by: "operator" });
    expect(merged.other).toBe(2);
  });
});
