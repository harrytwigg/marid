import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Every way a session leaves a run ends it and keeps the hops: a manual engine switch, a conversation
 * the engine lost, and (through the API) a reset. A connector's own transport meta never replaces what
 * the runtime kept.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fallback-run-clearing-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { clearDeadEngineSession } = await import("../turn/settle.js");
const { mergeTransportMeta } = await import("../manager.js");

const run = { source: "engine", position: 1, tried: ["claude||opus"], startedAt: "2026-10-19T10:00:00.000Z" };
const hops = [{ at: "2026-10-19T10:00:00.000Z", from: "claude||opus", to: "codex||", fromLabel: "claude · opus", toLabel: "codex", reason: "rate-limit" }];
const standing = { originalEngine: "claude", originalModel: "opus", until: "2999-01-01T00:00:00Z", syncSince: "2026-10-19T10:00:00.000Z" };

function walkedSession(ref: string): string {
  const s = reg.createSession({ engine: "codex", source: "web", sourceRef: ref, model: "gpt" });
  reg.recordEngineSessionId(s.id, "codex", "codex-thread");
  reg.updateSession(s.id, { transportMeta: { engineOverride: standing, fallbackRun: run, fallbackHops: hops, fallbackServedBy: { key: "codex||", label: "codex", at: "t" } } } as never);
  return s.id;
}
const metaOf = (id: string) => reg.getSession(id)!.transportMeta as Record<string, unknown>;

beforeEach(async () => {
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("a session leaving its run", () => {
  it("by a manual engine switch ends the run, the override, and keeps the hops", () => {
    const id = walkedSession("web:clear-switch");
    reg.switchSessionEngine(id, "claude", {});

    expect(metaOf(id).fallbackRun).toBeUndefined();
    expect(metaOf(id).engineOverride).toBeUndefined();
    expect(metaOf(id).fallbackHops).toEqual(hops);
  });

  it("by a conversation the engine lost ends the run and keeps the hops", () => {
    const id = walkedSession("web:clear-dead");
    clearDeadEngineSession(id, "codex", { lostConversation: true });

    expect(metaOf(id).fallbackRun).toBeUndefined();
    expect(metaOf(id).engineOverride).toBeUndefined();
    expect(metaOf(id).fallbackHops).toEqual(hops);
  });
});

describe("mergeTransportMeta", () => {
  it("keeps the run, the hops and who served, whatever a connector's meta says", () => {
    const existing = { fallbackRun: run, fallbackHops: hops, fallbackServedBy: { key: "k" }, other: 1 };
    const merged = mergeTransportMeta(existing as never, { fallbackRun: { position: 9 }, fallbackHops: [], fallbackServedBy: null, other: 2 } as never) as Record<string, unknown>;

    expect(merged.fallbackRun).toEqual(run);
    expect(merged.fallbackHops).toEqual(hops);
    expect(merged.fallbackServedBy).toEqual({ key: "k" });
    expect(merged.other).toBe(2);
  });
});
