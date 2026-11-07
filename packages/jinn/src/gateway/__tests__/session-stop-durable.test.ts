import { describe, expect, it, vi } from "vitest";
import { useContextMeterHarness } from "./session-context-api-harness.js";

/** A stop is durable: what was parked for the session is gone, and nothing wakes it but a deliberate start. */
const h = useContextMeterHarness();

/** A session mid-turn with an operator message and an agent message parked behind it. */
function runningWithParkedMessages() {
  const session = h.newSession("claude");
  h.registry.updateSession(session.id, { status: "running" });
  const key = session.sessionKey || session.sourceRef || session.id;
  const messageId = h.registry.insertMessage(session.id, "user", "carry on with the old plan");
  h.queueItems.enqueueQueueItem(session.id, key, "carry on with the old plan", { messageId });
  h.queueItems.enqueueQueueItem(session.id, key, "a reviewer's reply", { internal: true });
  return { session, key, messageId };
}

/** Counts every turn the gateway tries to start, without running one. */
function watchTurnStarts() {
  const enqueue = vi.fn(async () => {});
  const queue = {
    enqueue, clearCancelled: () => {}, clearQueue: () => {}, pauseQueue: () => {}, resumeQueue: () => {},
    holdForCallbackDrain: () => {}, releaseCallbackDrain: () => {}, hasInFlightItem: () => false,
    getPendingCount: () => 0, getRowlessWaitingCount: () => 0, getTransportState: (_key: string, status: string) => status,
  };
  const spy = vi.spyOn(h.apiCtx.sessionManager, "getQueue").mockReturnValue(queue as never);
  return { enqueue, restore: () => spy.mockRestore() };
}

describe("stop_session with messages queued", () => {
  it("drops them durably, so a replay starts no turn and the session stays stopped", async () => {
    const { session, messageId } = runningWithParkedMessages();
    const turns = watchTurnStarts();
    try {
      const stop = await h.request("POST", `/api/sessions/${session.id}/stop`);
      expect(stop.body).toMatchObject({ status: "stopped", noop: false, cancelledMessages: 2 });
      expect(h.pendingPrompts(session.id)).toEqual([]);
      expect(h.registry.getMessages(session.id).some((m) => m.id === messageId)).toBe(false);

      // What a gateway restart or a config reload does with every pending row.
      const { resumePendingWebQueueItems } = await import("../api.js");
      resumePendingWebQueueItems(h.apiCtx);

      expect(turns.enqueue).not.toHaveBeenCalled();
      expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
    } finally {
      turns.restore();
    }
  });

  it("keeps a row parked in a live lane from running once the turn settles, even after a deliberate send clears the lane's cancel flag", async () => {
    const { SessionQueue } = await import("../../sessions/queue.js");
    const queue = new SessionQueue();
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    const key = session.sessionKey || session.sourceRef || session.id;
    let release!: () => void;
    const turn = queue.enqueue(key, () => new Promise<void>((resolve) => { release = resolve; }), h.queueItems.enqueueQueueItem(session.id, key, "running"));
    await vi.waitFor(() => expect(queue.isRunning(key)).toBe(true));
    const parkedTurn = vi.fn(async () => {});
    const parked = queue.enqueue(key, parkedTurn, h.queueItems.enqueueQueueItem(session.id, key, "parked"));
    const spy = vi.spyOn(h.apiCtx.sessionManager, "getQueue").mockReturnValue(queue as never);
    try {
      await h.request("POST", `/api/sessions/${session.id}/stop`);
      queue.clearCancelled(key); // what a later deliberate message does before it enqueues its own turn
      release();
      await Promise.all([turn, parked]);
    } finally {
      spy.mockRestore();
    }
    expect(parkedTurn).not.toHaveBeenCalled();
    expect(h.pendingPrompts(session.id)).toEqual([]);
  });

  it("tells an agent sender its message was not delivered, and queues nothing", async () => {
    const { session } = runningWithParkedMessages();
    const stranger = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, {
      headers: h.asSession(stranger.id), body: { message: "ping" },
    });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ status: "not_delivered", sessionId: session.id });
    expect(sent.body.error).toMatch(/not delivered/);
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
  });

  it("refuses a relay posted for it as well", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const relayed = await h.request("POST", `/api/sessions/${session.id}/message`, {
      body: { role: "notification", from: "a colleague", message: "ping" },
    });
    expect(relayed.status).toBe(409);
    expect(relayed.body).toMatchObject({ status: "not_delivered" });
    expect(h.pendingPrompts(session.id)).toEqual([]);
  });

  it("starts again only on a deliberate message, and does not replay the one from before the stop", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const restarted = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "start over" } });
    expect(restarted.status).toBe(200);
    expect(h.pendingPrompts(session.id)).toEqual(["start over"]);
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "running" });
  });

  it("lets the session's own parent restart it by messaging it", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    h.registry.updateSession(child.id, { status: "running" });
    await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(parent.id) });

    const followUp = await h.request("POST", `/api/sessions/${child.id}/message`, {
      headers: h.asSession(parent.id), body: { message: "try again, differently" },
    });
    expect(followUp.status).toBe(200);
    expect(h.registry.getSession(child.id)).toMatchObject({ status: "running" });
  });
});

describe("stopping a session that is not running", () => {
  it("is a no-op, not an error, and leaves a finished session as it was", async () => {
    const session = h.newSession("claude");
    const first = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(first).toMatchObject({ status: 200, body: { status: "stopped", noop: true, cancelledMessages: 0 } });
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "idle" });
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(h.newSession("claude").id), body: { message: "hi" } })).status).toBe(200);
  });

  it("is a no-op the second time", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const again = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(again).toMatchObject({ status: 200, body: { status: "stopped", noop: true, cancelledMessages: 0 } });
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted", lastError: "Interrupted by user" });
  });
});
