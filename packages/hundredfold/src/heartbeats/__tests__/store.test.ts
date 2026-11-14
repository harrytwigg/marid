import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hundredfold-heartbeats-store-"));
process.env.HUNDREDFOLD_HOME = home;

type Store = typeof import("../store.js");
let store: Store;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM heartbeats").run();
});

function arm(ownerSessionId: string, overrides: Partial<Parameters<Store["armHeartbeat"]>[0]> = {}) {
  return store.armHeartbeat({
    ownerSessionId,
    message: "stay grounded",
    everySeconds: 60,
    ...overrides,
  });
}

describe("heartbeat store", () => {
  it("creates the heartbeats table during database initialization", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'heartbeats'",
    ).pluck().all();
    expect(tables).toEqual(["heartbeats"]);
  });

  it("arms a heartbeat owned by the given session and schedules it one interval out", () => {
    const now = 1_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: "session-a", message: "ping", everySeconds: 120 },
      now,
    );
    expect(heartbeat.ownerSessionId).toBe("session-a");
    expect(heartbeat.status).toBe("armed");
    expect(heartbeat.fireCount).toBe(0);
    expect(heartbeat.nextFireAt).toBe(now + 120_000);
    expect(store.getHeartbeat(heartbeat.id)).toEqual(heartbeat);
  });

  describe("limits", () => {
    it("refuses an interval under the 60-second floor, naming the floor and the fix", () => {
      expect(() => arm("session-a", { everySeconds: 59 }))
        .toThrow(/everySeconds is 59, below the 60-second floor\. Arm it at 60 or more/);
    });

    it("refuses a sixth concurrent armed heartbeat, naming the cap and the fix", () => {
      for (let i = 0; i < store.MAX_ARMED_PER_SESSION; i++) arm("session-a");
      expect(() => arm("session-a"))
        .toThrow(/already holds 5 armed heartbeats, the maximum of 5\. Stop one with stop_heartbeat/);
    });

    it("refuses a message over 2000 characters, naming the cap and the fix", () => {
      expect(() => arm("session-a", { message: "x".repeat(store.MESSAGE_MAX_CHARS + 1) }))
        .toThrow(/message is 2001 characters, over the 2000-character cap\. Shorten it/);
    });

    it("counts only armed heartbeats against the cap", () => {
      const stopped = arm("session-a");
      for (let i = 0; i < store.MAX_ARMED_PER_SESSION - 1; i++) arm("session-a");
      expect(store.stopHeartbeat(stopped.id, "session-a")).toBe(true);
      expect(() => arm("session-a")).not.toThrow();
    });

    it("scopes the cap per session", () => {
      for (let i = 0; i < store.MAX_ARMED_PER_SESSION; i++) arm("session-a");
      expect(() => arm("session-b")).not.toThrow();
    });
  });

  describe("ownership", () => {
    it("lists only the caller's own armed heartbeats", () => {
      const mine = arm("session-a");
      arm("session-b");
      expect(store.listHeartbeatsForSession("session-a").map((h) => h.id)).toEqual([mine.id]);
    });

    it("omits stopped heartbeats from the owner's list", () => {
      const heartbeat = arm("session-a");
      store.stopHeartbeat(heartbeat.id, "session-a");
      expect(store.listHeartbeatsForSession("session-a")).toEqual([]);
    });

    it("refuses to stop another session's heartbeat and leaves it armed", () => {
      const theirs = arm("session-b");
      expect(store.stopHeartbeat(theirs.id, "session-a")).toBe(false);
      expect(store.getHeartbeat(theirs.id)!.status).toBe("armed");
    });

    it("reports an unknown id the same way as someone else's", () => {
      expect(store.stopHeartbeat("no-such-heartbeat", "session-a")).toBe(false);
    });

    it("is not fooled into a second stop of an already-stopped heartbeat", () => {
      const heartbeat = arm("session-a");
      expect(store.stopHeartbeat(heartbeat.id, "session-a")).toBe(true);
      expect(store.stopHeartbeat(heartbeat.id, "session-a")).toBe(false);
    });
  });

  it("disarms every heartbeat a session owns, and nobody else's", () => {
    arm("session-a");
    arm("session-a");
    const other = arm("session-b");
    expect(store.disarmHeartbeatsForSession("session-a")).toBe(2);
    expect(store.listHeartbeatsForSession("session-a")).toEqual([]);
    expect(store.getHeartbeat(other.id)!.status).toBe("armed");
  });

  it("books a fire and reschedules from now rather than from the deadline just met", () => {
    const armedAt = 1_000_000;
    const heartbeat = arm("session-a", { everySeconds: 60 });
    const firedAt = armedAt + 500_000;
    const advanced = store.advanceHeartbeat(heartbeat.id, firedAt)!;
    expect(advanced.fireCount).toBe(1);
    expect(advanced.nextFireAt).toBe(firedAt + 60_000);
    expect(advanced.status).toBe("armed");
  });

  it("disarms on the fire that reaches maxFires", () => {
    const heartbeat = arm("session-a", { maxFires: 2 });
    expect(store.advanceHeartbeat(heartbeat.id, 1)!.status).toBe("armed");
    const final = store.advanceHeartbeat(heartbeat.id, 2)!;
    expect(final.fireCount).toBe(2);
    expect(final.status).toBe("disarmed");
    expect(final.disarmedReason).toBe("max-fires-reached");
  });
});
