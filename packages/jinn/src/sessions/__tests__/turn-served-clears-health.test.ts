import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";
import type { TurnSurface } from "../turn/types.js";

/**
 * A turn the engine answered is evidence its target can serve, so it clears a
 * limit the engine-health record still holds against that target. A turn that
 * began before the limit was recorded, and one that ended in an error, do not.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-turn-served-health-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { runTurn } = await import("../turn/runner.js");
const { readEngineHealth, recordEngineUnavailable } = await import("../../shared/engine-health.js");

const config = { gateway: {}, engines: { default: "claude", claude: { model: "opus" } }, sessions: {} } as unknown as JinnConfig;
const MIN = 60_000;

const surface: TurnSurface = { started: async () => {}, delta: () => {}, notice: async () => {}, reply: async () => {}, waiting: async () => {}, settled: async () => {} };

async function runOne(result: EngineResult, started?: () => void): Promise<void> {
  const s = reg.createSession({ engine: "claude", source: "web", sourceRef: `web:${Math.random()}`, model: "opus" });
  reg.insertMessage(s.id, "user", "hello");
  const attempt = reg.beginSessionAttempt(s.id)!;
  const engine: Engine = { name: "claude", async run() { started?.(); return result; } };
  await runTurn({
    session: reg.getSession(s.id)!, attemptToken: attempt.attemptToken!, prompt: "hello", attachments: [], config,
    engines: new Map([["claude", engine]]), gatewayBootId: "test-boot", connectorNames: [], channel: "web", user: "operator",
  }, surface);
}

/** A limit a turn on opus hit, recorded `minutes` ago against `key`. */
const spentMinutesAgo = (minutes: number, key = "claude") =>
  recordEngineUnavailable(key, "usage limit", (Date.now() + 4 * 24 * 60 * MIN) / 1000, new Date(Date.now() - minutes * MIN), { model: "opus" });

beforeEach(async () => {
  fs.rmSync(path.join(tmp, "tmp", "engine-health.json"), { force: true });
  const db = (await import("../../shared/db.js")).initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

describe("a turn concluded on the default Claude account", () => {
  it("clears a limit recorded before the turn began", async () => {
    spentMinutesAgo(30);

    await runOne({ sessionId: "t", result: "hi there", cost: 0.01 });

    expect(readEngineHealth().claude).toMatchObject({ state: "ok", clearedAt: expect.any(String), reason: "a turn was served" });
  });

  it("leaves a limit another session recorded while the turn was running", async () => {
    await runOne({ sessionId: "t", result: "hi there", cost: 0.01 }, () => spentMinutesAgo(-1));

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });

  it("credits the account the turn started on, not one the row was moved onto while it ran", async () => {
    const friend = "claude:friend01";
    spentMinutesAgo(30);
    spentMinutesAgo(30, friend);

    await runOne({ sessionId: "t", result: "hi there", cost: 0.01 }, () => {
      // Mid-turn the row is stood on another account: the turn still ran on the default one.
      const live = reg.listSessions().find((s) => s.status === "running")!;
      reg.updateSession(live.id, { transportMeta: { engineOverride: { originalEngine: "claude", originalAccount: "claude", substituteAccount: friend, substituteConfigDir: "/tmp/friend", until: new Date(Date.now() + 3600_000).toISOString() } } as never });
    });

    expect(readEngineHealth().claude?.clearedAt).toBeDefined();
    expect(readEngineHealth()[friend]?.state).toBe("exhausted");
  });

  it("leaves it when the turn ended in an error", async () => {
    spentMinutesAgo(30);

    await runOne({ sessionId: "t", result: "", error: "the connection dropped" });

    expect(readEngineHealth().claude?.state).toBe("exhausted");
  });
});
