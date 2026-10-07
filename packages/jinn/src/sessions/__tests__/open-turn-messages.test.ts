import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The messages a session's open turns will answer, so a transcript built for a
 * fresh conversation can leave them out: the running turn's own, and every one
 * queued behind it, whether its queue row links it or a callback delivery
 * batched it into one.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-open-turn-messages-"));
process.env.JINN_HOME = home;
const dbModule = await import("../../shared/db.js");
const registry = await import("../registry.js");
const { openTurnMessages } = await import("../queue-item-registry.js");

beforeEach(() => {
  dbModule.initDb().exec("DELETE FROM callback_deliveries; DELETE FROM queue_items; DELETE FROM messages; DELETE FROM sessions;");
});
afterAll(() => {
  dbModule.__closeDbForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

function createSession() {
  return registry.createSession({ engine: "stub", source: "web", sourceRef: "web:open", sessionKey: "web:open", connector: "web", prompt: "start" });
}

function acceptCallback(sessionId: string, sessionKey: string, n: number) {
  const { delivery } = registry.claimSessionDelivery({
    targetSessionId: sessionId,
    sourceKind: "session",
    sourceId: `child-${n}`,
    sourceAttempt: `attempt-${n}`,
    sourceOutcome: "succeeded",
    sourceVersion: 1,
    deliveryKind: "parent-completion",
    payload: { message: `framed reply ${n}`, displayMessage: `Worker replied ${n}`, meta: { kind: "child-reply", fullMessage: `reply ${n}` } },
  });
  return registry.acceptSessionDelivery(delivery.id, sessionId, sessionKey).delivery;
}

describe("openTurnMessages", () => {
  it("names the running and pending turns' messages and prompts, and nothing already answered", () => {
    const session = createSession();
    const key = session.sessionKey;
    const done = registry.enqueueQueueItem(session.id, key, "answered", { messageId: "msg-done" });
    registry.markQueueItemRunning(done);
    registry.markQueueItemCompleted(done);
    const running = registry.enqueueQueueItem(session.id, key, "current", { messageId: "msg-current" });
    registry.markQueueItemRunning(running);
    registry.enqueueQueueItem(session.id, key, "queued", { messageId: "msg-queued" });
    registry.enqueueQueueItem(session.id, key, "no message row");

    const open = openTurnMessages(session.id);
    expect(open.prompts.sort()).toEqual(["current", "no message row", "queued"]);
    expect([...open.messageIds].sort()).toEqual(["msg-current", "msg-queued"]);
  });

  it("names every callback batched into an open turn", () => {
    const session = createSession();
    const first = acceptCallback(session.id, session.sessionKey, 1);
    const second = acceptCallback(session.id, session.sessionKey, 2);

    expect(second.queueItemId).toBe(first.queueItemId);
    expect([...openTurnMessages(session.id).messageIds].sort()).toEqual([first.messageId, second.messageId].sort());
  });
});
