import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../../mcp/identity.js";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * One `send_to_session` that arrives twice (an MCP transport replay of
 * the same pending `tools/call`) must land as ONE turn. These drive the real
 * route, real SQLite and a real SessionQueue; only the engine is a stub, and it
 * blocks so the send stays in flight for the whole replay window — which is the
 * window the incident happened in.
 */

beforeEach(resetCallbackState);

/** An engine whose turn does not finish until the test releases it. */
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

async function post(
  context: ApiContext,
  sessionId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: `/api/sessions/${sessionId}/message`,
    headers: {
      host: "gateway.test",
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...headers,
    },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

/** The headers the jinn MCP toolkit puts on a tool-origin gateway call. */
function toolHeaders(callerSessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: callerSessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
  };
}

function queueRows(sessionId: string): Array<{ id: string; status: string; internal: number }> {
  return dbModule.initDb()
    .prepare("SELECT id, status, internal FROM queue_items WHERE session_id = ? ORDER BY position ASC")
    .all(sessionId) as Array<{ id: string; status: string; internal: number }>;
}

function notifications(sessionId: string) {
  return registry.getMessages(sessionId).filter((message) => message.role === "notification");
}

describe("a replayed lateral send lands once", () => {
  it("collapses a second POST of the same tool call into the first queue row", async () => {
    const { engine, prompts, release } = blockingEngine();
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("lateral-replay-target");
    const caller = createParent("lateral-replay-caller");

    const first = await post(context, target.id, { message: "ship it" }, toolHeaders(caller.id));
    const replay = await post(context, target.id, { message: "ship it" }, toolHeaders(caller.id));

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: "queued" });
    expect(queueRows(target.id)).toHaveLength(1);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      status: "duplicate",
      sessionId: target.id,
      queueItemId: queueRows(target.id)[0].id,
    });
    expect(notifications(target.id)).toHaveLength(1);

    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(1);
    });
  });

  it("survives a concurrent burst of identical sends", async () => {
    const { engine, prompts, release } = blockingEngine();
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("lateral-burst-target");
    const caller = createParent("lateral-burst-caller");

    const responses = await Promise.all(Array.from({ length: 10 }, () => (
      post(context, target.id, { message: "burst" }, toolHeaders(caller.id))
    )));

    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(responses.filter((response) => response.body.status === "duplicate")).toHaveLength(9);
    expect(queueRows(target.id)).toHaveLength(1);
    expect(notifications(target.id)).toHaveLength(1);

    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(1);
    });
  });

  it("leaves the operator's own sends alone — no identity, no dedupe", async () => {
    const { engine, prompts, release } = blockingEngine();
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("lateral-operator-target");

    const first = await post(context, target.id, { message: "same words twice" });
    const second = await post(context, target.id, { message: "same words twice" });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.status, second.body.status]).toEqual(["queued", "queued"]);
    expect(queueRows(target.id)).toHaveLength(2);
    expect(registry.getMessages(target.id).filter((message) => message.role === "user")).toHaveLength(2);

    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(2);
    });
  });
});

describe("the pending-queue resume sweep", () => {
  it("does not re-dispatch an item this process is already holding", async () => {
    const { engine, prompts, release } = blockingEngine();
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue);
    const target = createParent("resume-storm-target");
    const caller = createParent("resume-storm-caller");
    // Occupy the session's serial queue, so the send below stays `pending`:
    // parked behind a running turn is exactly what the sweep cannot see.
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    void queue.enqueue(target.sessionKey, () => blocked);
    await post(context, target.id, { message: "queued behind a long turn" }, toolHeaders(caller.id));
    const [item] = queueRows(target.id);
    expect(item.status).toBe("pending");

    const dispatches = vi.spyOn(queue, "enqueue");
    for (let reload = 0; reload < 3; reload++) api.resumePendingWebQueueItems(context);

    expect(dispatches.mock.calls.filter((call) => call[2] === item.id)).toHaveLength(0);
    dispatches.mockRestore();

    releaseBlocker();
    release();
    await eventually(() => {
      expect(queue.isRunning(target.sessionKey)).toBe(false);
      expect(prompts).toHaveLength(1);
      expect(queueRows(target.id)[0].status).toBe("completed");
    });
  });
});
