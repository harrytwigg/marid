import { PassThrough } from "node:stream";
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
  /** Turns started on this session's lane: other sessions' rows in the shared database replay too. */
  const startsOn = (session: { sessionKey?: string | null; sourceRef?: string | null; id: string }) =>
    (enqueue.mock.calls as unknown[][]).filter((call) => call[0] === (session.sessionKey || session.sourceRef || session.id)).length;
  return { enqueue, startsOn, restore: () => spy.mockRestore() };
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

      expect(turns.startsOn(session)).toBe(0);
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

/** A Todo/callback delivery claimed for `sessionId`, the way the outbox does before it POSTs. */
function claimDelivery(sessionId: string, attempt: string) {
  return h.registry.claimSessionDelivery({
    targetSessionId: sessionId, sourceKind: "work-item", sourceId: "W-1", sourceAttempt: attempt,
    sourceOutcome: "comment", sourceVersion: 1, deliveryKind: "comment",
    payload: { message: `todo wake ${attempt}`, displayMessage: `todo wake ${attempt}` },
  }).delivery;
}

describe("callback and Todo deliveries to a stopped session", () => {
  it("cancels an accepted one parked behind the turn, keeps its report in the transcript, and a replay starts nothing", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    const delivery = claimDelivery(session.id, "parked");
    h.registry.claimSessionDeliveryAttempt(delivery.id, Date.now(), 60_000);
    const accepted = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { callbackDeliveryId: delivery.id } });
    expect(accepted.status).toBe(200);
    expect(h.pendingPrompts(session.id)).toHaveLength(1);

    const turns = watchTurnStarts();
    try {
      expect((await h.request("POST", `/api/sessions/${session.id}/stop`)).body).toMatchObject({ cancelledMessages: 1, noop: false });
      expect(h.pendingPrompts(session.id)).toEqual([]);
      expect(h.registry.getMessages(session.id).some((m) => String(m.content).includes("todo wake parked"))).toBe(true);
      const { resumePendingWebQueueItems } = await import("../api.js");
      resumePendingWebQueueItems(h.apiCtx);
      expect(turns.startsOn(session)).toBe(0);
      expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
    } finally {
      turns.restore();
    }
  });

  it("gives up on one that arrives after the stop: refused, dead-lettered, nothing queued", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const delivery = claimDelivery(session.id, "late");
    h.registry.claimSessionDeliveryAttempt(delivery.id, Date.now(), 60_000);

    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { callbackDeliveryId: delivery.id } });
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ status: "not_delivered" });
    expect(h.registry.getSessionDelivery(delivery.id)).toMatchObject({ status: "dead_letter" });
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
  });

  it("does not count a stopped session as the employee's live session on a Todo", async () => {
    const { isLiveEmployeeSession } = await import("../../work-items/employee-sessions.js");
    const { session } = runningWithParkedMessages();
    const onTodo = { ...session, employee: "dev", workItemId: "W-1" };
    expect(isLiveEmployeeSession({ ...onTodo, status: "idle" }, "W-1", "dev")).toBe(true);
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const stopped = h.registry.getSession(session.id)!;
    expect(isLiveEmployeeSession({ ...stopped, employee: "dev", workItemId: "W-1" }, "W-1", "dev")).toBe(false);
  });
});

describe("what counts as stopped, and who may start it again", () => {
  it("survives anything else overwriting the session's last error", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    h.registry.updateSession(session.id, { lastError: "Engine not available" });
    const stranger = h.newSession("claude");
    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } });
    expect(sent.status).toBe(409);
  });

  it("lets any ancestor of the session start it again, and only an ancestor", async () => {
    const grandparent = h.newSession("claude");
    const parent = h.newSession("claude", { parentSessionId: grandparent.id });
    const child = h.newSession("claude", { parentSessionId: parent.id });
    h.registry.updateSession(child.id, { status: "running" });
    expect((await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(grandparent.id) })).status).toBe(200);
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${child.id}/message`, { headers: h.asSession(stranger.id), body: { message: "no" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${child.id}/message`, { headers: h.asSession(grandparent.id), body: { message: "again" } })).status).toBe(200);
    expect(h.registry.getSession(child.id)).toMatchObject({ status: "running" });
  });

  it("stops a session whose turn ended with background work still going", async () => {
    const session = h.newSession("claude");
    const killed = vi.fn();
    const spy = vi.spyOn(h.apiCtx.sessionManager, "getEngine").mockReturnValue({ ...h.apiCtx.sessionManager.getEngine("claude")!, kill: killed } as never);
    (h.apiCtx as { backgroundActivity?: Map<string, unknown> }).backgroundActivity = new Map([[session.id, { activeStreams: 0, backgroundAgents: 1, lastActivityAt: Date.now() }]]);
    try {
      const stop = await h.request("POST", `/api/sessions/${session.id}/stop`);
      expect(stop.body).toMatchObject({ status: "stopped", noop: false });
      expect(killed).toHaveBeenCalled();
      expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
    } finally {
      spy.mockRestore();
      delete (h.apiCtx as { backgroundActivity?: unknown }).backgroundActivity;
    }
  });

  it("makes a restart-interrupted session stopped for good: the resume mark goes and agents are refused", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, {
      status: "interrupted", lastError: "Interrupted: gateway shutting down gracefully",
      transportMeta: { [h.registry.RESTART_RESUME_META_KEY]: new Date().toISOString() },
    });
    const stop = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(stop.body).toMatchObject({ noop: false });
    expect(h.registry.getSession(session.id)!.transportMeta?.[h.registry.RESTART_RESUME_META_KEY]).toBeUndefined();
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${session.id}/stop`)).body).toMatchObject({ noop: true });
  });
});

/** POST a message whose body arrives in two parts, so a stop can land between them. */
async function slowSend(sessionId: string, headers: Record<string, string>, body: unknown, between: () => Promise<unknown>) {
  const { handleApiRequest } = await import("../api.js");
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    method: "POST", url: `/api/sessions/${sessionId}/message`,
    headers: { host: "gateway.test", "content-type": "application/json", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) },
  });
  let status = 0;
  const chunks: string[] = [];
  const res = {
    statusCode: 200, writeHead(code: number) { status = code; return this; }, setHeader() { return this; }, getHeader() { return undefined; },
    write(chunk: unknown) { chunks.push(String(chunk)); return true; }, end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); if (!status) status = 200; },
  };
  const raw = JSON.stringify(body);
  stream.write(raw.slice(0, 10));
  const handled = handleApiRequest(req as never, res as never, h.apiCtx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await between();
  stream.end(raw.slice(10));
  await handled;
  return { status, body: JSON.parse(chunks.join("") || "{}") as Record<string, unknown> };
}

describe("a stop racing what is already on its way", () => {
  it("refuses a send whose body was still arriving when the stop landed", async () => {
    const session = h.newSession("claude");
    h.registry.updateSession(session.id, { status: "running" });
    const stranger = h.newSession("claude");
    const turns = watchTurnStarts();
    try {
      const sent = await slowSend(session.id, h.asSession(stranger.id), { message: "carry on with the old plan" },
        () => h.request("POST", `/api/sessions/${session.id}/stop`));
      expect(sent).toMatchObject({ status: 409, body: { status: "not_delivered" } });
      expect(turns.startsOn(session)).toBe(0);
      expect(h.pendingPrompts(session.id)).toEqual([]);
      expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
      const { isStoppedByUser } = await import("../session-stop.js");
      expect(isStoppedByUser(session)).toBe(true);
    } finally {
      turns.restore();
    }
  });

  it("does not replay the stopped turn's own row when the gateway restarts before the turn settles", async () => {
    const session = h.newSession("claude");
    const key = session.sessionKey || session.sourceRef || session.id;
    const row = h.queueItems.enqueueQueueItem(session.id, key, "the old plan, in progress");
    h.queueItems.markQueueItemRunning(row);
    h.registry.updateSession(session.id, { status: "running" });
    const turns = watchTurnStarts();
    try {
      await h.request("POST", `/api/sessions/${session.id}/stop`);
      // The gateway dies before the killed turn's lane settles its row; the next boot:
      h.registry.recoverStaleQueueItems();
      const { resumePendingWebQueueItems } = await import("../api.js");
      resumePendingWebQueueItems(h.apiCtx);
      expect(turns.startsOn(session)).toBe(0);
      expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted" });
    } finally {
      turns.restore();
    }
  });

  it("drops, rather than replays, a row a stopped session still holds", async () => {
    const session = h.newSession("claude");
    const key = session.sessionKey || session.sourceRef || session.id;
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    h.queueItems.enqueueQueueItem(session.id, key, "slipped in after the stop");
    const turns = watchTurnStarts();
    try {
      const { resumePendingWebQueueItems } = await import("../api.js");
      resumePendingWebQueueItems(h.apiCtx);
      expect(turns.startsOn(session)).toBe(0);
      expect(h.pendingPrompts(session.id)).toEqual([]);
    } finally {
      turns.restore();
    }
  });
});

describe("the stop ends when the session runs again, by any path", () => {
  it("is cleared by a turn that did not come through the web send, so a later restart does not bring it back", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    // A connector reply runs the session through the manager, which starts its
    // own attempt; the turn ends; a gateway restart later marks it interrupted.
    h.registry.beginSessionAttempt(session.id);
    h.registry.updateSession(session.id, { status: "idle" });
    h.registry.updateSession(session.id, { status: "interrupted", lastError: "Interrupted: gateway shutting down gracefully" });

    const delivery = claimDelivery(session.id, "after-restart");
    h.registry.claimSessionDeliveryAttempt(delivery.id, Date.now(), 60_000);
    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { callbackDeliveryId: delivery.id } });
    expect(sent.status).toBe(200);
    expect(h.registry.getSessionDelivery(delivery.id)!.status).not.toBe("dead_letter");
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } })).status).toBe(200);
  });

  it("is cleared by a turn waiting on a usage limit too", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    h.registry.updateSession(session.id, { status: "waiting" });
    h.registry.updateSession(session.id, { status: "interrupted" });
    const { isStoppedByUser } = await import("../session-stop.js");
    expect(isStoppedByUser(h.registry.getSession(session.id)!)).toBe(false);
  });
});

describe("stopping a session that is not running", () => {
  it("holds a finished session stopped without touching its status, and refuses a later wake", async () => {
    const session = h.newSession("claude");
    const first = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(first).toMatchObject({ status: 200, body: { status: "stopped", noop: false, wasRunning: false, cancelledMessages: 0 } });
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "idle" });
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "your review came back" } })).status).toBe(409);
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ status: "idle", stopped: true });
    expect((await h.request("POST", `/api/sessions/${session.id}/stop`)).body).toMatchObject({ noop: true, cancelledMessages: 0 });
  });

  it("counts every message it drops from an idle session, a held delivery's included", async () => {
    const session = h.newSession("claude");
    const key = session.sessionKey || session.sourceRef || session.id;
    h.queueItems.enqueueQueueItem(session.id, key, "held for later", { internal: true });
    const delivery = claimDelivery(session.id, "held");
    h.registry.claimSessionDeliveryAttempt(delivery.id, Date.now(), 60_000);
    h.registry.updateSession(session.id, { status: "running" }); // park the delivery behind a turn
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { body: { callbackDeliveryId: delivery.id } })).status).toBe(200);
    h.registry.updateSession(session.id, { status: "idle" });
    expect(h.pendingPrompts(session.id)).toHaveLength(2);
    const stop = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(stop.body).toMatchObject({ status: "stopped", noop: false, wasRunning: false, cancelledMessages: 2 });
    expect(h.pendingPrompts(session.id)).toEqual([]);
  });

  it("is a no-op the second time", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const again = await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect(again).toMatchObject({ status: 200, body: { status: "stopped", noop: true, cancelledMessages: 0 } });
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "interrupted", lastError: "Interrupted by user" });
  });
});

describe("the context meter's compact on a stopped session", () => {
  it("is refused with 409 and starts nothing, so the session stays stopped to everyone else", async () => {
    const { session } = runningWithParkedMessages();
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const usage = await h.request("GET", `/api/sessions/${session.id}/context-usage`);
    expect(usage.body.compact).toMatchObject({ available: false, reason: { code: "stopped" } });
    const compact = await h.request("POST", `/api/sessions/${session.id}/compact`);
    expect(compact.status).toBe(409);
    expect(compact.body).toMatchObject({ code: "stopped" });
    expect(compact.body.error).toMatch(/stopped/);

    expect(h.loopbacks()).toEqual([]);
    expect(h.pendingPrompts(session.id)).toEqual([]);
    expect(h.selfCompactionAt(session.id)).toBeUndefined();
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ status: "interrupted", stopped: true });
    const stranger = h.newSession("claude");
    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } });
    expect(sent.status).toBe(409);
  });

  it("is refused for a session stopped while idle as well", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    expect((await h.request("POST", `/api/sessions/${session.id}/compact`)).status).toBe(409);
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ status: "idle", stopped: true });
  });
});

describe("a deliberate send to a session stopped while idle", () => {
  /** A replay while the accepted turn is still held, as a config reload does. */
  async function replayWhileHeld() {
    const { resumePendingWebQueueItems } = await import("../api.js");
    resumePendingWebQueueItems(h.apiCtx);
  }

  it("ends the stop when the operator's message is accepted, so a replay before its turn keeps the message", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);

    const sent = await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "pick it up again" } });
    expect(sent.status).toBe(200);
    // The queue stub never runs the turn: it is held, and the session is still idle.
    expect(h.registry.getSession(session.id)).toMatchObject({ status: "idle" });
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ stopped: false });

    await replayWhileHeld();
    expect(h.pendingPrompts(session.id)).toEqual(["pick it up again"]);
    expect(h.registry.getMessages(session.id).map((m) => m.content)).toContain("pick it up again");
  });

  it("ends it for an ancestor's message too", async () => {
    const parent = h.newSession("claude");
    const child = h.newSession("claude", { parentSessionId: parent.id });
    await h.request("POST", `/api/sessions/${child.id}/stop`, { headers: h.asSession(parent.id) });

    const sent = await h.request("POST", `/api/sessions/${child.id}/message`, {
      headers: h.asSession(parent.id), body: { message: "try again, differently" },
    });
    expect(sent.status).toBe(200);
    await replayWhileHeld();
    expect(h.pendingPrompts(child.id)).toHaveLength(1);
    expect(h.pendingPrompts(child.id)[0]).toContain("try again, differently");
  });

  it("does not end it for a sender it refuses, or for a send that fails validation", async () => {
    const session = h.newSession("claude");
    await h.request("POST", `/api/sessions/${session.id}/stop`);
    const stranger = h.newSession("claude");
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { headers: h.asSession(stranger.id), body: { message: "ping" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { body: { role: "notification", from: "a colleague", message: "ping" } })).status).toBe(409);
    expect((await h.request("POST", `/api/sessions/${session.id}/message`, { body: { message: "x", delivery: "sideways" } })).status).toBe(400);
    expect((await h.request("GET", `/api/sessions/${session.id}`)).body).toMatchObject({ stopped: true });
  });
});
