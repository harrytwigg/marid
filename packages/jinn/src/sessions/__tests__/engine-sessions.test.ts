import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// Isolate the DB: JINN_HOME must be set before importing registry (SESSIONS_DB
// is resolved at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-engine-sessions-"));
process.env.JINN_HOME = tmp;
const migrateModule = await import("../migrate.js");
const reg = await import("../registry.js");

describe("engine session refs", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
  });

  it("migrates legacy session tables with a dedicated engine_sessions column", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        engine_session_id TEXT,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        employee TEXT,
        model TEXT,
        status TEXT DEFAULT 'idle',
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        last_error TEXT
      )
    `);

    migrateModule.migrateSessionsSchema(db);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("engine_sessions");
  });

  it("records native ids per engine without letting inactive engines replace the active id", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:engine-refs",
      model: "opus",
      effortLevel: "high",
    });

    const claude = reg.recordEngineSessionId(s.id, "claude", "claude-native-1", {
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
      platformContextFingerprint: "claude-fingerprint",
    });
    expect(claude?.engineSessionId).toBe("claude-native-1");
    expect(reg.getEngineSessionRef(claude!, "claude")).toEqual({
      id: "claude-native-1",
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
      platformContextFingerprint: "claude-fingerprint",
    });

    const codex = reg.recordEngineSessionId(s.id, "codex", "codex-native-1", {
      model: "gpt-5.5",
      effortLevel: "medium",
      platformContextFingerprint: "codex-fingerprint",
    });
    expect(codex?.engineSessionId).toBe("claude-native-1");
    expect(reg.getEngineSessionRef(codex!, "codex")).toEqual({
      id: "codex-native-1",
      model: "gpt-5.5",
      effortLevel: "medium",
      platformContextFingerprint: "codex-fingerprint",
    });
  });

  it("switches active engines by restoring saved native ids instead of creating a new ref", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:switch",
      model: "opus",
      effortLevel: "high",
    });
    reg.recordEngineSessionId(s.id, "claude", "claude-native-1", {
      model: "opus",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
      platformContextFingerprint: "claude-fingerprint",
    });

    const switchedToCodex = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    expect(switchedToCodex?.engine).toBe("codex");
    expect(switchedToCodex?.engineSessionId).toBeNull();
    expect(switchedToCodex?.model).toBe("gpt-5.5");
    expect(switchedToCodex?.effortLevel).toBe("medium");
    expect(switchedToCodex?.transportMeta?.engineSyncTarget).toBe("codex");
    expect(switchedToCodex?.transportMeta?.engineSyncSince).toBe(s.createdAt);

    reg.recordEngineSessionId(s.id, "codex", "codex-native-1", {
      model: "gpt-5.5",
      effortLevel: "medium",
      lastSyncedAt: "2026-07-07T08:05:00.000Z",
      platformContextFingerprint: "codex-fingerprint",
    });

    const switchedBack = reg.switchSessionEngine(s.id, "claude", {
      model: "opus",
      effortLevel: "high",
    });
    expect(switchedBack?.engine).toBe("claude");
    expect(switchedBack?.engineSessionId).toBe("claude-native-1");
    expect(switchedBack?.model).toBe("opus");
    expect(switchedBack?.effortLevel).toBe("high");
    expect(switchedBack?.transportMeta?.engineSyncTarget).toBe("claude");
    expect(switchedBack?.transportMeta?.engineSyncSince).toBe("2026-07-07T08:00:00.000Z");
    expect(reg.getEngineSessionRef(switchedBack!, "claude").platformContextFingerprint).toBe("claude-fingerprint");
    expect(reg.getEngineSessionRef(switchedBack!, "codex").platformContextFingerprint).toBe("codex-fingerprint");
  });

  it("clears only the reset engine's platform context fingerprint", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:reset-fingerprint" });
    reg.recordEngineSessionId(s.id, "claude", "claude-native", { platformContextFingerprint: "claude-fingerprint" });
    reg.recordEngineSessionId(s.id, "codex", "codex-native", { platformContextFingerprint: "codex-fingerprint" });

    const reset = reg.clearEngineSessionRefs(s.id, "claude")!;

    expect(reg.getEngineSessionRef(reset, "claude").platformContextFingerprint).toBeUndefined();
    expect(reg.getEngineSessionRef(reset, "codex").platformContextFingerprint).toBe("codex-fingerprint");
  });

  it("preserves a legacy active engine_session_id when switching away", () => {
    const s = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:legacy-switch",
      model: "opus",
      effortLevel: "high",
    });
    reg.updateSession(s.id, { engineSessionId: "legacy-claude-native" });

    const switched = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });

    expect(reg.getEngineSessionRef(switched!, "claude").id).toBe("legacy-claude-native");
    expect(switched?.engineSessionId).toBeNull();
  });

  it("refuses the mirror as the active engine's resume id while a rate-limit override is live", () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:override-mirror" });
    reg.recordEngineSessionId(s.id, "claude", "claude-native-1");

    // The exact state the rate-limit fallback used to persist: the engine flipped to
    // codex while the mirror kept Claude's thread id and no typed codex ref existed.
    const override = { originalEngine: "claude", originalEngineSessionId: "claude-native-1", until: "2099-01-01T00:00:00.000Z" };
    const midOverride = reg.updateSession(s.id, { engine: "codex", transportMeta: { engineOverride: override } })!;
    expect(midOverride.engineSessionId).toBe("claude-native-1");

    // Resuming codex with a Claude thread id is the defect — the ref must come back empty.
    expect(reg.getEngineSessionRef(midOverride, "codex").id).toBeUndefined();
    // Claude's own ref is untouched, so the revert can still restore it.
    expect(reg.getEngineSessionRef(midOverride, "claude").id).toBe("claude-native-1");
  });

  it("reverts a codex-primary session to its own parked thread once the override window passes", async () => {
    const { maybeRevertEngineOverride } = await import("../engine-override.js");
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:codex-override" });
    reg.recordEngineSessionId(s.id, "codex", "codex-native-1");

    // The state the rate-limit fallback writes when codex rolls to claude, with a
    // window that has already closed.
    reg.updateSession(s.id, {
      engine: "claude",
      engineSessionId: null,
      transportMeta: {
        engineOverride: {
          originalEngine: "codex",
          originalEngineSessionId: "codex-native-1",
          until: "2020-01-01T00:00:00.000Z",
          syncSince: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    reg.recordEngineSessionId(s.id, "claude", "claude-substitute-1");

    const reverted = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect(reverted.engine).toBe("codex");
    expect(reverted.engineSessionId).toBe("codex-native-1");
    // The substitute's own thread stays parked under its ref, and the spent record goes.
    expect(reg.getEngineSessionRef(reverted, "claude").id).toBe("claude-substitute-1");
    expect(reverted.transportMeta?.engineOverride).toBeUndefined();
  });

  it("restores the model the pin belonged to alongside the engine it belonged to", async () => {
    const { maybeRevertEngineOverride } = await import("../engine-override.js");
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:codex-model-revert" });

    // The state the swap now writes: the pin off the row and parked on the record,
    // because a codex model id means nothing while claude is the one running.
    reg.updateSession(s.id, {
      engine: "claude",
      engineSessionId: null,
      model: null,
      transportMeta: {
        engineOverride: {
          originalEngine: "codex",
          originalEngineSessionId: "codex-native-1",
          originalModel: "gpt-5.6-luna",
          until: "2020-01-01T00:00:00.000Z",
        },
      },
    });

    const reverted = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect(reverted.engine).toBe("codex");
    expect(reverted.model).toBe("gpt-5.6-luna");
  });

  it("restores no pin from an override record that parked none, rather than inventing one", async () => {
    const { maybeRevertEngineOverride } = await import("../engine-override.js");
    const s = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:codex-no-parked-model" });
    reg.updateSession(s.id, {
      engine: "claude",
      model: "opus",
      transportMeta: {
        engineOverride: { originalEngine: "codex", originalEngineSessionId: "codex-native-1", until: "2020-01-01T00:00:00.000Z" },
      },
    });

    const reverted = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect(reverted.engine).toBe("codex");
    expect(reverted.model).toBe("opus");
  });

  it("does not resume a saved Grok native session when switching back with a different Grok model", () => {
    const s = reg.createSession({
      engine: "grok",
      source: "web",
      sourceRef: "web:grok-model-bound",
      model: "grok-build",
      effortLevel: "high",
    });
    reg.recordEngineSessionId(s.id, "grok", "grok-native-1", {
      model: "grok-build",
      effortLevel: "high",
      lastSyncedAt: "2026-07-07T08:00:00.000Z",
    });

    const switchedToCodex = reg.switchSessionEngine(s.id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    expect(switchedToCodex?.engineSessionId).toBeNull();

    const switchedBack = reg.switchSessionEngine(s.id, "grok", {
      model: "grok-composer-2.5-fast",
      effortLevel: "medium",
    });

    expect(switchedBack?.engine).toBe("grok");
    expect(switchedBack?.engineSessionId).toBeNull();
    expect(switchedBack?.model).toBe("grok-composer-2.5-fast");
    expect(reg.getEngineSessionRef(switchedBack!, "grok")).toEqual({
      model: "grok-composer-2.5-fast",
      effortLevel: "medium",
    });
    expect(switchedBack?.transportMeta?.engineSyncSince).toBe(s.createdAt);
  });
});
