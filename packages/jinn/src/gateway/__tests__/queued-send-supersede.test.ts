import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  createParent,
  dbModule,
  eventually,
  makeContext,
  queueModule,
  registry,
  resetCallbackState,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse } from "./helpers/callback-requests.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * A sender takes back its own parked `send_to_session` message when a later one
 * replaces it. These drive the real route, real SQLite and a real SessionQueue;
 * only the engine is a stub, and it blocks so the target stays mid-turn while
 * the sender changes its mind — the window the incident happened in.
 */

beforeEach(resetCallbackState);

function blockingEngine(): { engine: Engine; prompts: string[]; release: () => void } {
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine: Engine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      prompts.push(opts.prompt);
      await gate;
      return { sessionId: "stub", result: "acknowledged" };
    },
  };
  return { engine, prompts, release: () => release() };
}

async function post(context: ApiContext, sessionId: string, body: unknown, headers: Record<string, string> = {}, route = "message") {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/sessions/${sessionId}/${route}`,
    headers: { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

function toolHeaders(callerSessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: callerSessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
  };
}

function queueRows(sessionId: string): Array<{ id: string; status: string; message_id: string | null }> {
  return dbModule.initDb()
    .prepare("SELECT id, status, message_id FROM queue_items WHERE session_id = ? ORDER BY position ASC")
    .all(sessionId) as Array<{ id: string; status: string; message_id: string | null }>;
}

function notifications(sessionId: string) {
  return registry.getMessages(sessionId).filter((message) => message.role === "notification");
}

/** A target already mid-turn on a message of the operator's, so sends to it park. */
async function busyTarget(suffix: string) {
  const blocking = blockingEngine();
  const events: Array<{ event: string; data: unknown }> = [];
  const queue = new queueModule.SessionQueue();
  const context = makeContext(blocking.engine, queue, events);
  const target = createParent(`supersede-${suffix}-target`);
  const caller = createParent(`supersede-${suffix}-caller`);
  await post(context, target.id, { message: "start a long turn" });
  await eventually(() => expect(blocking.prompts).toHaveLength(1));
  return { ...blocking, queue, context, events, target, caller };
}

describe("superseding a parked send", () => {
  it("delivers only the replacement when the first is superseded while the target is mid-turn", async () => {
    const { prompts, release, queue, context, events, target, caller } = await busyTarget("replace");

    const first = await post(context, target.id, { message: "use route A" }, toolHeaders(caller.id));
    const second = await post(
      context, target.id, { message: "use route B instead", supersedes: first.body.queueItemId }, toolHeaders(caller.id),
    );

    expect(first.body).toMatchObject({ status: "queued", targetRunning: true, queuedFromYou: 1 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "queued", targetRunning: true, queuedFromYou: 1, superseded: "withdrawn" });
    expect(queueRows(target.id).map((row) => row.status)).toEqual(["running", "cancelled", "pending"]);
    expect(notifications(target.id)).toHaveLength(1);
    expect(notifications(target.id)[0].content).toContain("use route B instead");
    expect(events).toContainEqual({
      event: "queue:updated",
      data: expect.objectContaining({ sessionId: target.id, withdrawnMessageId: queueRows(target.id)[1].message_id }),
    });

    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("use route B instead");
    expect(prompts.join("\n")).not.toContain("use route A");
  });

  it("lets a chain of corrections each replace the last, so only the final one is delivered", async () => {
    const { prompts, release, queue, context, target, caller } = await busyTarget("chain");

    const one = await post(context, target.id, { message: "plan one" }, toolHeaders(caller.id));
    const two = await post(context, target.id, { message: "plan two", supersedes: one.body.queueItemId }, toolHeaders(caller.id));
    const three = await post(context, target.id, { message: "plan three", supersedes: two.body.queueItemId }, toolHeaders(caller.id));

    expect(three.body).toMatchObject({ superseded: "withdrawn", queuedFromYou: 1 });
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("plan three");
    expect(prompts.join("\n")).not.toMatch(/plan (one|two)/);
  });

  it("without supersedes, still delivers both in order and says how many are queued", async () => {
    const { prompts, release, queue, context, target, caller } = await busyTarget("both");

    await post(context, target.id, { message: "first ask" }, toolHeaders(caller.id));
    const second = await post(context, target.id, { message: "second ask" }, toolHeaders(caller.id));

    expect(second.body).toMatchObject({ targetRunning: true, queuedFromYou: 2 });
    expect(second.body).not.toHaveProperty("superseded");
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(3);
    });
    expect(prompts[1]).toContain("first ask");
    expect(prompts[2]).toContain("second ask");
  });

  it("still delivers the replacement, and says so, when the first has already left the queue", async () => {
    const { prompts, release, queue, context, target, caller } = await busyTarget("late");
    const first = await post(context, target.id, { message: "already taken" }, toolHeaders(caller.id));
    dbModule.initDb().prepare("UPDATE queue_items SET status = 'running' WHERE id = ?").run(first.body.queueItemId);

    const second = await post(context, target.id, { message: "too late to retract", supersedes: first.body.queueItemId }, toolHeaders(caller.id));

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "queued", superseded: "too-late" });
    expect(notifications(target.id)).toHaveLength(2);
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts.join("\n")).toContain("too late to retract");
    });
  });

  it("refuses an id that is not the sender's own send to this session, and queues nothing", async () => {
    const { release, queue, context, target, caller } = await busyTarget("foreign");
    const other = createParent("supersede-foreign-other");
    const elsewhere = createParent("supersede-foreign-elsewhere");
    const theirs = await post(context, target.id, { message: "someone else's brief" }, toolHeaders(other.id));
    const toElsewhere = await post(context, elsewhere.id, { message: "to another session" }, toolHeaders(caller.id));
    const before = queueRows(target.id);

    for (const supersedes of [theirs.body.queueItemId, toElsewhere.body.queueItemId, "no-such-item", ""]) {
      const refused = await post(context, target.id, { message: "hijack", supersedes }, toolHeaders(caller.id));
      expect(refused.status).toBe(400);
    }

    expect(queueRows(target.id)).toEqual(before);
    expect(queueRows(target.id).find((row) => row.id === theirs.body.queueItemId)?.status).toBe("pending");
    expect(notifications(target.id).map((message) => message.content).join("\n")).not.toContain("hijack");
    release();
    await eventually(() => expect(queue.isRunning(target.sessionKey)).toBe(false));
  });

  it("treats a replayed superseding call as the same send: one replacement, nothing withdrawn twice", async () => {
    const { prompts, release, queue, context, target, caller } = await busyTarget("replay");
    const first = await post(context, target.id, { message: "old" }, toolHeaders(caller.id));
    const body = { message: "new", supersedes: first.body.queueItemId };

    const sent = await post(context, target.id, body, toolHeaders(caller.id));
    const replay = await post(context, target.id, body, toolHeaders(caller.id));

    expect(replay.body).toEqual({ status: "duplicate", sessionId: target.id, queueItemId: sent.body.queueItemId });
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("new");
  });

  it("withdraws the superseded send even when the replacement is words the sender already has queued", async () => {
    const { prompts, release, queue, context, events, target, caller } = await busyTarget("dedupe");
    const alpha = await post(context, target.id, { message: "alpha" }, toolHeaders(caller.id));
    const beta = await post(context, target.id, { message: "beta" }, toolHeaders(caller.id));

    const again = await post(context, target.id, { message: "beta", supersedes: alpha.body.queueItemId }, toolHeaders(caller.id));

    expect(again.body).toEqual({
      status: "duplicate", sessionId: target.id, queueItemId: beta.body.queueItemId, superseded: "withdrawn",
    });
    expect(queueRows(target.id).map((row) => row.status)).toEqual(["running", "cancelled", "pending"]);
    expect(notifications(target.id)).toHaveLength(1);
    expect(events).toContainEqual({
      event: "queue:updated",
      data: expect.objectContaining({ sessionId: target.id, withdrawnMessageId: queueRows(target.id)[1].message_id }),
    });
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
    expect(prompts[1]).toContain("beta");
    expect(prompts.join("\n")).not.toContain("alpha");
  });

  it("leaves a send alone when it is replaced by its own words", async () => {
    const { release, queue, context, target, caller } = await busyTarget("same-words");
    const first = await post(context, target.id, { message: "same" }, toolHeaders(caller.id));

    const again = await post(context, target.id, { message: "same", supersedes: first.body.queueItemId }, toolHeaders(caller.id));

    expect(again.body).toEqual({ status: "duplicate", sessionId: target.id, queueItemId: first.body.queueItemId });
    expect(queueRows(target.id).map((row) => row.status)).toEqual(["running", "pending"]);
    release();
    await eventually(() => expect(queue.isRunning(target.sessionKey)).toBe(false));
  });

  it("announces a live notification under the id a withdrawal will name", async () => {
    const { release, queue, context, events, target, caller } = await busyTarget("announce");
    await post(context, target.id, { message: "heads up" }, toolHeaders(caller.id));

    expect(events).toContainEqual({
      event: "session:notification",
      data: expect.objectContaining({ sessionId: target.id, messageId: queueRows(target.id)[1].message_id }),
    });
    release();
    await eventually(() => expect(queue.isRunning(target.sessionKey)).toBe(false));
  });
});

describe("a stop with an agent's message parked", () => {
  it("cancels the row and drops its bubble, as it does for the operator's own messages", async () => {
    const { release, context, events, target, caller } = await busyTarget("stop");
    await post(context, target.id, { message: "parked behind the long turn" }, toolHeaders(caller.id));
    const parked = queueRows(target.id)[1];
    expect(notifications(target.id)).toHaveLength(1);

    const stopped = await post(context, target.id, {}, {}, "stop");

    expect(stopped.status).toBe(200);
    expect(queueRows(target.id).find((row) => row.id === parked.id)?.status).toBe("cancelled");
    expect(notifications(target.id)).toHaveLength(0);
    expect(events).toContainEqual({
      event: "queue:updated",
      data: expect.objectContaining({ sessionId: target.id, withdrawnMessageIds: [parked.message_id] }),
    });
    release();
  });
});
