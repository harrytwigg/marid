import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Heartbeat } from "../types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-heartbeats-scheduler-"));
process.env.JINN_HOME = home;

type Store = typeof import("../store.js");
type Scheduler = typeof import("../scheduler.js");
type Registry = typeof import("../../sessions/registry.js");

let store: Store;
let scheduler: Scheduler;
let registry: Registry;
let db: import("better-sqlite3").Database;

const EVERY = 60;
const INTERVAL_MS = EVERY * 1000;

beforeAll(async () => {
  store = await import("../store.js");
  scheduler = await import("../scheduler.js");
  registry = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM heartbeats").run();
});

let sessionSeq = 0;

/** A real session row, so the scheduler's owner-liveness check runs for real. */
function owner(): string {
  return registry.createSession({ engine: "claude", source: "web", sourceRef: `owner-${++sessionSeq}` }).id;
}

/** Collect what actually reached a session, in order. */
function recorder() {
  const delivered: Array<{ sessionId: string; text: string; fire: number }> = [];
  const deliver = (heartbeat: Heartbeat, fireCount: number) => {
    delivered.push({ sessionId: heartbeat.ownerSessionId, text: heartbeat.message, fire: fireCount });
  };
  return { delivered, deliver };
}

describe("heartbeat scheduler", () => {
  // The scheduler's own arithmetic. That the text also survives the real
  // delivery path, as a notification, is proven end to end in
  // gateway/__tests__/heartbeat-delivery.test.ts.
  it("hands the armed text to delivery on each interval, twice past 2N and no more", () => {
    const sessionId = owner();
    const text = "Check the deploy queue before you keep going.";
    let clock = 1_000_000;
    store.armHeartbeat({ ownerSessionId: sessionId, message: text, everySeconds: EVERY }, clock);
    const { delivered, deliver } = recorder();

    scheduler.sweepOnce({ now: () => clock, deliver });
    expect(delivered).toHaveLength(0); // not due yet

    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    // Past 2N, where a scheduler that drifted early would fire a third time.
    clock += INTERVAL_MS / 2;
    scheduler.sweepOnce({ now: () => clock, deliver });

    expect(delivered).toHaveLength(2);
    expect(delivered.map((d) => d.sessionId)).toEqual([sessionId, sessionId]);
    // Byte-for-byte: the stored text is the delivered text, with nothing composed around it.
    expect(delivered.map((d) => d.text)).toEqual([text, text]);
    expect(delivered.map((d) => d.fire)).toEqual([1, 2]);
  });

  it("fires a deadline ten intervals stale exactly once when the scheduler starts, then resumes from now", () => {
    const sessionId = owner();
    const clock = 2_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: sessionId, message: "still here", everySeconds: EVERY },
      clock,
    );
    // Simulate a gateway that was down: the deadline is ten intervals stale.
    db.prepare("UPDATE heartbeats SET next_fire_at = ? WHERE id = ?")
      .run(clock - 10 * INTERVAL_MS, heartbeat.id);
    const { delivered, deliver } = recorder();

    // Catch-up has to come from the started scheduler's own timer, not from a
    // sweep the test drives by hand — restart recovery is what AC5 is about.
    vi.useFakeTimers();
    try {
      const stop = scheduler.startHeartbeatScheduler({ intervalMs: 1_000, now: () => clock, deliver });
      // Two ticks at the same instant: the catch-up, then nothing left to do.
      vi.advanceTimersByTime(2_000);
      stop();
      // A stopped scheduler cannot sweep again, however long the process runs.
      vi.advanceTimersByTime(60_000);
    } finally {
      vi.useRealTimers();
    }

    expect(delivered).toHaveLength(1);
    const after = store.getHeartbeat(heartbeat.id)!;
    expect(after.status).toBe("armed");
    expect(after.nextFireAt).toBe(clock + INTERVAL_MS);
  });

  it("delivers nothing more once stopped", () => {
    const sessionId = owner();
    let clock = 3_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: sessionId, message: "tick", everySeconds: EVERY },
      clock,
    );
    const { delivered, deliver } = recorder();

    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    expect(delivered).toHaveLength(1);

    expect(store.stopHeartbeat(heartbeat.id, sessionId, clock)).toBe(true);

    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    expect(delivered).toHaveLength(1);
  });

  it("auto-disarms after maxFires deliveries without a stop call", () => {
    const sessionId = owner();
    let clock = 4_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: sessionId, message: "twice only", everySeconds: EVERY, maxFires: 2 },
      clock,
    );
    const { delivered, deliver } = recorder();

    for (let tick = 0; tick < 5; tick++) {
      clock += INTERVAL_MS;
      scheduler.sweepOnce({ now: () => clock, deliver });
    }

    expect(delivered).toHaveLength(2);
    const after = store.getHeartbeat(heartbeat.id)!;
    expect(after.status).toBe("disarmed");
    expect(after.disarmedReason).toBe("max-fires-reached");
  });

  it("auto-disarms an already-expired heartbeat without delivering", () => {
    const sessionId = owner();
    const clock = 5_000_000;
    const heartbeat = store.armHeartbeat(
      {
        ownerSessionId: sessionId,
        message: "too late",
        everySeconds: EVERY,
        expiresAt: clock - 1,
      },
      clock,
    );
    const { delivered, deliver } = recorder();

    scheduler.sweepOnce({ now: () => clock + INTERVAL_MS, deliver });
    scheduler.sweepOnce({ now: () => clock + 2 * INTERVAL_MS, deliver });

    expect(delivered).toHaveLength(0);
    const after = store.getHeartbeat(heartbeat.id)!;
    expect(after.status).toBe("disarmed");
    expect(after.disarmedReason).toBe("expired");
  });

  it("disarms instead of delivering when the owning session row is gone", () => {
    const sessionId = owner();
    let clock = 6_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: sessionId, message: "orphan", everySeconds: EVERY },
      clock,
    );
    expect(registry.deleteSession(sessionId)).toBe(true);
    const { delivered, deliver } = recorder();

    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });

    expect(delivered).toHaveLength(0);
    const after = store.getHeartbeat(heartbeat.id)!;
    expect(after.status).toBe("disarmed");
    expect(after.disarmedReason).toBe("owner-session-deleted");
  });
});

describe("heartbeat for a stopped owner", () => {
  it("holds its ticks without spending a fire while the owner is stopped, and fires again once it runs", async () => {
    const { markSessionStopped } = await import("../../sessions/stopped-marker.js");
    const sessionId = owner();
    let clock = 2_000_000;
    const armed = store.armHeartbeat({ ownerSessionId: sessionId, message: "check in", everySeconds: EVERY, maxFires: 2 }, clock);
    registry.updateSession(sessionId, { status: "interrupted" });
    markSessionStopped(sessionId);
    const { delivered, deliver } = recorder();

    for (let tick = 0; tick < 3; tick++) {
      clock += INTERVAL_MS;
      scheduler.sweepOnce({ now: () => clock, deliver });
    }
    expect(delivered).toEqual([]);
    expect(store.getHeartbeat(armed.id)).toMatchObject({ status: "armed", fireCount: 0, nextFireAt: clock + INTERVAL_MS });

    registry.beginSessionAttempt(sessionId); // a deliberate start
    clock += INTERVAL_MS;
    scheduler.sweepOnce({ now: () => clock, deliver });
    expect(delivered).toEqual([{ sessionId, text: "check in", fire: 1 }]);
  });
});
