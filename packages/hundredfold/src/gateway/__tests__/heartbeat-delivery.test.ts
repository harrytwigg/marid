import { describe, expect, it } from "vitest";
import {
  acceptWithoutExecuting,
  createParent,
  dbModule,
  eventually,
  makeContext,
  makeEngine,
  registry,
} from "./helpers/callback-harness.js";
import { withRouteBackedFetch } from "./helpers/callback-requests.js";

// Imported after the harness, which sets HUNDREDFOLD_HOME before anything opens the DB.
const store = await import("../../heartbeats/store.js");
const scheduler = await import("../../heartbeats/scheduler.js");

const EVERY = 60;
const INTERVAL_MS = EVERY * 1000;

/** The engine-facing side of each tick that reached the session, in arrival order. */
function deliveredPrompts(sessionId: string): string[] {
  const rows = dbModule.initDb()
    .prepare("SELECT prompt FROM queue_items WHERE session_id = ? ORDER BY position ASC")
    .all(sessionId) as Array<{ prompt: string }>;
  return rows.map((row) => row.prompt);
}

function notificationsFor(sessionId: string): string[] {
  return registry.getMessages(sessionId)
    .filter((message) => message.role === "notification")
    .map((message) => message.content);
}

/**
 * The scheduler running the REAL delivery path — no injected recorder — so a
 * tick travels the durable outbox, the session message route and SQLite exactly
 * as it does in the gateway. Wrapping `payload.message` in composed prose, or
 * taking heartbeats off the notification path, fails this test.
 */
describe("heartbeat delivery into its owning session", () => {
  it("arrives twice past two intervals, as a notification, carrying the armed text verbatim", async () => {
    const owner = createParent("heartbeat-owner");
    const context = makeContext(makeEngine([]), acceptWithoutExecuting());
    const text = "Check the deploy queue before you keep going.";
    const armedAt = 1_000_000;
    const heartbeat = store.armHeartbeat(
      { ownerSessionId: owner.id, message: text, everySeconds: EVERY },
      armedAt,
    );

    await withRouteBackedFetch(context, {}, async () => {
      // Simulated time runs to two and a half intervals: two deadlines pass, and
      // the last sweep is there to prove the third has not.
      for (const intervals of [0.5, 1, 2, 2.5]) {
        scheduler.sweepOnce({ now: () => armedAt + intervals * INTERVAL_MS });
      }
      await eventually(() => {
        expect(deliveredPrompts(owner.id)).toHaveLength(2);
      });
    });

    expect(store.getHeartbeat(heartbeat.id)!.fireCount).toBe(2);
    // Byte for byte: what the engine reads is the armed text with nothing composed
    // around it. Only the human-facing banner is decorated.
    expect(deliveredPrompts(owner.id)).toEqual([text, text]);
    // And it lands as a notification, which is what queues it behind a running
    // turn instead of interrupting one.
    expect(notificationsFor(owner.id)).toEqual([`⏰ ${text}`, `⏰ ${text}`]);
  });
});
