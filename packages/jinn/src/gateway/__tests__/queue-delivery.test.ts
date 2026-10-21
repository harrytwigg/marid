import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  createParent,
  eventually,
  makeContext,
  queueModule,
  registry,
  resetCallbackState,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse } from "./helpers/callback-requests.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * The per-message delivery choice against the real route handler, a real
 * SessionQueue and real SQLite: `delivery: "queue"` waits for the running
 * turn, `delivery: "now"` cuts it off, and the queue's send-now verb
 * force-sends everything parked. Queued messages drain one per turn, in
 * the order they were sent.
 */

beforeEach(resetCallbackState);

const HEADERS = {
  host: "gateway.test",
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

async function request(
  context: ApiContext,
  method: string,
  url: string,
  body?: unknown,
) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { ...HEADERS },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

const send = (context: ApiContext, sessionId: string, message: string, extra: Record<string, unknown> = {}) =>
  request(context, "POST", `/api/sessions/${sessionId}/message`, { message, ...extra });

interface QueueRow { id: string; prompt: string; status: string }

const parkedRows = async (context: ApiContext, sessionId: string): Promise<QueueRow[]> =>
  ((await request(context, "GET", `/api/sessions/${sessionId}/queue`)).body as QueueRow[])
    .filter((row) => row.status === "pending");

const transcriptTexts = async (context: ApiContext, sessionId: string): Promise<string[]> =>
  (((await request(context, "GET", `/api/sessions/${sessionId}`)).body as { messages?: Array<{ content: string }> }).messages ?? [])
    .map((message) => message.content);

/** An interruptible engine whose turn ends only when released or killed. */
function interruptibleBlockingEngine() {
  const prompts: string[] = [];
  const kills: Array<string | undefined> = [];
  const releases: Array<() => void> = [];
  let alive = false;
  const engine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      alive = true;
      await new Promise<void>((resolve) => { releases.push(resolve); });
      alive = false;
      return { sessionId: "stub", result: "acknowledged" };
    },
    kill: (_sessionId: string, reason?: string) => { kills.push(reason); releases.shift()?.(); },
    isAlive: () => alive,
    killAll: () => {},
  } as unknown as Engine;
  return { engine, prompts, kills, releaseNext: () => releases.shift()?.() };
}

async function runningInterruptibleSession(suffix: string) {
  const stub = interruptibleBlockingEngine();
  const queue = new queueModule.SessionQueue();
  const events: Array<{ event: string; data: unknown }> = [];
  const context = makeContext(stub.engine, queue, events);
  const session = createParent(suffix);
  await send(context, session.id, "running turn");
  await eventually(() => expect(stub.prompts).toEqual(["running turn"]));
  return { ...stub, context, queue, session, events };
}

describe("POST /message delivery choice", () => {
  it("queues two messages behind a running turn without interrupting, then delivers them in order, one per turn", async () => {
    const { context, session, prompts, kills, releaseNext } = await runningInterruptibleSession("delivery-queue");
    await send(context, session.id, "queued one", { delivery: "queue" });
    await send(context, session.id, "queued two", { delivery: "queue" });

    expect(kills).toEqual([]);
    expect(prompts).toEqual(["running turn"]);
    expect((await parkedRows(context, session.id)).map((row) => row.prompt)).toEqual(["queued one", "queued two"]);

    releaseNext();
    await eventually(() => expect(prompts).toEqual(["running turn", "queued one"]));
    releaseNext();
    await eventually(() => expect(prompts).toEqual(["running turn", "queued one", "queued two"]));
    releaseNext();
  });

  it("send-now delivery interrupts the running turn as before", async () => {
    const { context, session, prompts, kills, releaseNext } = await runningInterruptibleSession("delivery-now");
    await send(context, session.id, "do this instead", { delivery: "now" });

    expect(kills).toHaveLength(1);
    // The interrupted turn's prompt is carried forward into the next turn's.
    await eventually(() => expect(prompts[1]).toContain("do this instead"));
    releaseNext();
  });

  it("send-now with messages already queued runs next, ahead of them, then the queue in order", async () => {
    const { context, session, prompts, kills, releaseNext } = await runningInterruptibleSession("delivery-now-ahead");
    await send(context, session.id, "parked one", { delivery: "queue" });
    await send(context, session.id, "parked two", { delivery: "queue" });

    const urgent = await send(context, session.id, "urgent correction", { delivery: "now" });

    expect(kills).toHaveLength(1);
    // The response names the row that now carries the urgent message: the head.
    const parked = await parkedRows(context, session.id);
    expect(parked.map((row) => row.prompt)).toEqual(["urgent correction", "parked one", "parked two"]);
    expect((urgent.body as { queueItemId: string }).queueItemId).toBe(parked[0].id);
    // The cut-off turn's prompt is carried forward into the urgent one.
    await eventually(() => expect(prompts[1]).toContain("urgent correction"));
    expect(prompts[1]).not.toContain("parked one");
    releaseNext();
    await eventually(() => expect(prompts[2]).toBe("parked one"));
    releaseNext();
    await eventually(() => expect(prompts[3]).toBe("parked two"));
    releaseNext();
  });

  it("refuses an unknown delivery value instead of falling back to interrupting", async () => {
    const { context, session, prompts, kills, releaseNext } = await runningInterruptibleSession("delivery-unknown");

    const refused = await send(context, session.id, "typo", { delivery: "later" });

    expect(refused.status).toBe(400);
    expect(kills).toEqual([]);
    expect(await parkedRows(context, session.id)).toEqual([]);
    expect(await transcriptTexts(context, session.id)).not.toContain("typo");
    expect(prompts).toEqual(["running turn"]);
    releaseNext();
  });

  it("does not deliver a cancelled queued message", async () => {
    const { context, session, prompts, releaseNext } = await runningInterruptibleSession("delivery-cancel");
    await send(context, session.id, "keep me", { delivery: "queue" });
    await send(context, session.id, "drop me", { delivery: "queue" });
    const dropped = (await parkedRows(context, session.id)).find((row) => row.prompt === "drop me")!;

    const cancelled = await request(context, "DELETE", `/api/sessions/${session.id}/queue/${dropped.id}`);
    expect(cancelled.status).toBe(200);
    // Its bubble goes with it: a message that never ran must not read as sent.
    expect(await transcriptTexts(context, session.id)).toContain("keep me");
    expect(await transcriptTexts(context, session.id)).not.toContain("drop me");

    releaseNext();
    await eventually(() => expect(prompts).toEqual(["running turn", "keep me"]));
    releaseNext();
    // Give a wrongly-delivered cancelled message a chance to appear, then check it did not.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(prompts).toEqual(["running turn", "keep me"]);
  });

  it("cancel withdraws whichever message the row holds now, after a send-now moved it", async () => {
    const { context, session, releaseNext } = await runningInterruptibleSession("delivery-cancel-moved");
    await send(context, session.id, "first parked", { delivery: "queue" });
    const second = await send(context, session.id, "second parked", { delivery: "queue" });
    const [headRow, secondRow] = await parkedRows(context, session.id);
    // Promote the second; its payload moves onto the head row, and the first onto the other.
    await request(context, "POST", `/api/sessions/${session.id}/queue/${secondRow.id}/send-now`, {});

    const cancelled = await request(context, "DELETE", `/api/sessions/${session.id}/queue/${headRow.id}`);

    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { messageId?: string }).messageId).toBe((second.body as { messageId: string }).messageId);
    expect(await transcriptTexts(context, session.id)).not.toContain("second parked");
    expect(await transcriptTexts(context, session.id)).toContain("first parked");
    releaseNext();
    releaseNext();
  });

  it("refuses to cancel a queued message through another session", async () => {
    const { context, session, releaseNext } = await runningInterruptibleSession("delivery-cancel-owner");
    await send(context, session.id, "not yours", { delivery: "queue" });
    const parked = (await parkedRows(context, session.id))[0]!;
    const other = createParent("delivery-cancel-other");

    const refused = await request(context, "DELETE", `/api/sessions/${other.id}/queue/${parked.id}`);

    expect(refused.status).toBe(404);
    expect((await parkedRows(context, session.id)).map((row) => row.prompt)).toEqual(["not yours"]);
    expect(await transcriptTexts(context, session.id)).toContain("not yours");
    releaseNext();
    releaseNext();
  });
});

describe("DELETE /api/sessions/:id/queue (clear all)", () => {
  it("withdraws every parked message's bubble, names them in the event, and delivers none", async () => {
    const { context, session, prompts, events, releaseNext } = await runningInterruptibleSession("clear-all");
    const first = await send(context, session.id, "clear me one", { delivery: "queue" });
    const second = await send(context, session.id, "clear me two", { delivery: "queue" });
    events.length = 0;

    const cleared = await request(context, "DELETE", `/api/sessions/${session.id}/queue`);

    const ids = [(first.body as { messageId: string }).messageId, (second.body as { messageId: string }).messageId];
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ status: "cleared", cancelled: 2, messageIds: ids });
    expect(events).toEqual([
      { event: "queue:updated", data: expect.objectContaining({ sessionId: session.id, depth: 0, withdrawnMessageIds: ids }) },
    ]);
    // The running turn's bubble stays; the two that never ran leave the transcript.
    const texts = await transcriptTexts(context, session.id);
    expect(texts).toContain("running turn");
    expect(texts).not.toContain("clear me one");
    expect(texts).not.toContain("clear me two");
    expect(await parkedRows(context, session.id)).toEqual([]);

    releaseNext();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(prompts).toEqual(["running turn"]);
  });

  it("leaves an internal callback row, and the message it carries, in place", async () => {
    const { context, session, events, releaseNext } = await runningInterruptibleSession("clear-internal");
    await send(context, session.id, "operator parked", { delivery: "queue" });
    const callbackMessageId = registry.insertMessage(session.id, "notification", "child finished");
    registry.enqueueQueueItem(session.id, session.sessionKey, "callback prompt", { internal: true, messageId: callbackMessageId });
    events.length = 0;

    const cleared = await request(context, "DELETE", `/api/sessions/${session.id}/queue`);

    expect(cleared.body).toMatchObject({ status: "cleared", cancelled: 1 });
    expect(events).toHaveLength(1);
    expect((events[0].data as { withdrawnMessageIds: string[] }).withdrawnMessageIds).toHaveLength(1);
    expect((events[0].data as { withdrawnMessageIds: string[] }).withdrawnMessageIds).not.toContain(callbackMessageId);
    expect(await transcriptTexts(context, session.id)).not.toContain("operator parked");
    expect(await transcriptTexts(context, session.id)).toContain("child finished");
    expect(registry.listAllPendingQueueItems().map((item) => item.prompt)).toEqual(["callback prompt"]);
    releaseNext();
  });

  it("names no messages when nothing was parked", async () => {
    const { context, session, events, releaseNext } = await runningInterruptibleSession("clear-empty");
    events.length = 0;

    const cleared = await request(context, "DELETE", `/api/sessions/${session.id}/queue`);

    expect(cleared.body).toEqual({ status: "cleared", cancelled: 0 });
    expect(events).toEqual([{ event: "queue:updated", data: { sessionId: session.id, sessionKey: session.sessionKey, depth: 0 } }]);
    releaseNext();
  });
});

describe("POST /api/sessions/:id/queue/send-now (all)", () => {
  it("interrupts the running turn and drains every queued message in queue order", async () => {
    const { context, session, prompts, kills, releaseNext } = await runningInterruptibleSession("force-all");
    await send(context, session.id, "first queued", { delivery: "queue" });
    await send(context, session.id, "second queued", { delivery: "queue" });
    expect(kills).toEqual([]);

    const forced = await request(context, "POST", `/api/sessions/${session.id}/queue/send-now`, {});

    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ status: "sent-now", count: 2 });
    expect(kills).toHaveLength(1);
    // The interrupted turn's prompt is carried forward into the next turn's.
    await eventually(() => expect(prompts[1]).toContain("first queued"));
    releaseNext();
    await eventually(() => expect(prompts[2]).toContain("second queued"));
    expect(prompts).toHaveLength(3);
    releaseNext();
  });

  it("refuses while the queue is paused, leaving the running turn alone", async () => {
    const { context, session, kills, releaseNext } = await runningInterruptibleSession("force-paused");
    await send(context, session.id, "held", { delivery: "queue" });
    await request(context, "POST", `/api/sessions/${session.id}/queue/pause`, {});

    const refused = await request(context, "POST", `/api/sessions/${session.id}/queue/send-now`, {});
    const held = (await parkedRows(context, session.id))[0]!;
    const refusedOne = await request(context, "POST", `/api/sessions/${session.id}/queue/${held.id}/send-now`, {});
    // An interrupting message waits too: nothing would drain behind the cut.
    const urgent = await send(context, session.id, "urgent while paused", { delivery: "now" });

    expect(refused.status).toBe(409);
    expect(refusedOne.status).toBe(409);
    expect(urgent.status).toBe(200);
    expect(kills).toEqual([]);
    expect((await parkedRows(context, session.id)).map((row) => row.prompt)).toEqual(["held", "urgent while paused"]);
    await request(context, "POST", `/api/sessions/${session.id}/queue/resume`, {});
    releaseNext();
    releaseNext();
    releaseNext();
  });

  it("does not interrupt when nothing is queued", async () => {
    const { context, session, kills } = await runningInterruptibleSession("force-none");
    const forced = await request(context, "POST", `/api/sessions/${session.id}/queue/send-now`, {});
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ status: "sent-now", count: 0 });
    expect(kills).toEqual([]);
  });
});
