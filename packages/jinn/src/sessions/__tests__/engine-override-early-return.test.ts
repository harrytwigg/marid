import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A stand-in held to its window returns early once the session's own target has
 * been positively cleared since the swap. Only a clear does it: a record that
 * lapsed, a clear older than the swap, or a target exhausted again leave the
 * stand-in holding to its window, which is what an unstated reset relies on.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-override-early-return-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { beginEngineSubstitution, maybeRevertEngineOverride, ownTargetCleared } = await import("../engine-override.js");
const { extendSpentWindow, ownTargetClearedSince } = await import("../engine-override-window.js");
const { standingOverride } = await import("../engine-override-revert.js");
const health = await import("../../shared/engine-health.js");
const { claudeProfileFromDir } = await import("../../shared/claude-profile.js");

const friend = claudeProfileFromDir("/Users/operator/.claude-friend");
const FRIEND_ACCOUNT = `claude:${friend.key}`;
const config = { engines: { default: "claude", claude: { bin: "claude", model: "opus" } } } as never;
const STATE_PATH = path.join(tmp, "tmp", "engine-health.json");

const BASE = Date.now();
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const iso = (minutes: number) => at(minutes).toISOString();
/** The own account's record, observed `minutes` from now, stating a reset four days out. */
const spend = (minutes: number, key = "claude") =>
  health.recordEngineUnavailable(key, "usage limit", (BASE + 4 * 24 * 3600_000) / 1000, at(minutes), { window: "7d" });
const clear = (minutes: number, key = "claude") => health.recordEngineServed(key, at(minutes - 1).getTime(), at(minutes));

function swapped(ref: string, syncSinceMinutes: number, kind: "account" | "engine" = "account") {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: `web:${ref}`, model: "opus" });
  reg.recordEngineSessionId(s.id, "claude", "own-thread");
  reg.updateSession(s.id, { status: "running", attemptToken: "attempt-1" } as never);
  const common = {
    session: reg.getSession(s.id)!, attemptToken: "attempt-1", config, employee: undefined,
    until: new Date(BASE + 3 * 24 * 3600_000), syncSince: iso(syncSinceMinutes), lastError: "limit",
  };
  if (kind === "account") {
    beginEngineSubstitution({ ...common, substitute: "claude", accounts: { original: "claude", substitute: FRIEND_ACCOUNT, substituteConfigDir: friend.dir } });
  } else {
    beginEngineSubstitution({ ...common, substitute: "codex" });
  }
  return reg.getSession(s.id)!;
}

const standingOn = (id: string) => {
  const session = reg.getSession(id)!;
  return `${session.engine}${(session.transportMeta as Record<string, unknown> | null)?.engineOverride ? " (stand-in)" : ""}`;
};

beforeEach(async () => {
  fs.rmSync(STATE_PATH, { force: true });
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

afterEach(() => fs.rmSync(STATE_PATH, { force: true }));

describe.each(["account", "engine"] as const)("an %s stand-in held to a window days away", (kind) => {
  it("stays put with no record of the own target", () => {
    const s = swapped(`none-${kind}`, -60, kind);
    const after = maybeRevertEngineOverride(s);
    expect(after.id).toBe(s.id);
    expect(standingOn(s.id)).toContain("stand-in");
  });

  it("returns at the next turn once the own target is cleared after the swap", () => {
    spend(-120);
    const s = swapped(`cleared-${kind}`, -60, kind);
    expect(ownTargetCleared(s)).toBe(false);
    clear(-30);

    expect(ownTargetCleared(reg.getSession(s.id)!)).toBe(true);
    const after = maybeRevertEngineOverride(reg.getSession(s.id)!);

    expect(after.engine).toBe("claude");
    expect(after.engineSessionId).toBe("own-thread");
    expect((after.transportMeta as Record<string, unknown>).engineOverride).toBeUndefined();
  });

  it("stays put on a clear older than the swap", () => {
    spend(-180);
    clear(-120);
    const s = swapped(`old-clear-${kind}`, -60, kind);

    expect(ownTargetCleared(s)).toBe(false);
    maybeRevertEngineOverride(s);
    expect(standingOn(s.id)).toContain("stand-in");
  });

  it("stays put when the record merely lapsed: only a positive clear counts", () => {
    // A stated reset already behind us: it reads back ok, with no clearedAt.
    health.recordEngineUnavailable("claude", "usage limit", (BASE - 3600_000) / 1000, at(-180));
    const s = swapped(`lapsed-${kind}`, -60, kind);
    expect(health.readEngineHealth().claude?.state).toBe("ok");

    expect(ownTargetCleared(s)).toBe(false);
    maybeRevertEngineOverride(s);
    expect(standingOn(s.id)).toContain("stand-in");
  });

  it("stays put when the own target is exhausted again after the clear", () => {
    spend(-120);
    const s = swapped(`again-${kind}`, -90, kind);
    clear(-60);
    spend(-10);

    expect(ownTargetCleared(reg.getSession(s.id)!)).toBe(false);
    maybeRevertEngineOverride(reg.getSession(s.id)!);
    expect(standingOn(s.id)).toContain("stand-in");
  });
});

describe("a cleared record in the window extension", () => {
  it("extendSpentWindow extends on an exhausted record and does not on a cleared one", () => {
    spend(-120);
    const s = swapped("extend", -60);
    const meta = s.transportMeta as Record<string, unknown>;
    const override = meta.engineOverride as Record<string, unknown>;
    const own = { engine: "claude", model: "opus" };

    const extended = extendSpentWindow(s, meta, override, own, {});
    expect(extended).toBeDefined();
    expect((extended!.transportMeta as { engineOverride: { until: string } }).engineOverride.until).toBe(iso(-120 + 12 * 60)); // the record's re-probe, twelve hours after it was observed

    clear(-30);
    expect(extendSpentWindow(reg.getSession(s.id)!, meta, override, own, {})).toBeUndefined();
  });

  it("a window that has passed ends on a cleared own target instead of being extended", () => {
    spend(-120);
    const s = swapped("passed", -60);
    clear(-30);
    const meta = s.transportMeta as Record<string, Record<string, unknown>>;
    reg.updateSession(s.id, { transportMeta: { ...meta, engineOverride: { ...meta.engineOverride, until: "2020-01-01T00:00:00.000Z" } } as never });

    expect(maybeRevertEngineOverride(reg.getSession(s.id)!).engine).toBe("claude");
    expect((reg.getSession(s.id)!.transportMeta as Record<string, unknown>).engineOverride).toBeUndefined();
  });
});

describe("ownTargetClearedSince", () => {
  it("counts any clear when the override carries no sync point", () => {
    clear(-500);
    spend(-600);
    clear(-500);
    const s = swapped("nosync", -60);
    const override = { ...(standingOverride(s) as Record<string, unknown>) };
    delete override.syncSince;
    expect(ownTargetClearedSince(s, override, { engine: "claude", model: "opus" }, {})).toBe(true);
  });

  it("is false for a session with no override, and for an auto-resume session", () => {
    const plain = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:plain" });
    expect(ownTargetCleared(plain)).toBe(false);

    spend(-120);
    const s = swapped("auto", -60);
    clear(-30);
    expect(ownTargetCleared({ ...s, fallbackMode: "auto-resume" })).toBe(false);
  });
});
