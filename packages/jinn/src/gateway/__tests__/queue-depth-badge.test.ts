import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  createParent,
  eventually,
  makeContext,
  queueModule,
  resetCallbackState,
  type ApiContext,
} from "./helpers/callback-harness.js";
import { makeResponse } from "./helpers/callback-requests.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * The session list's `queueDepth` feeds the sidebar's "N queued" badge, so it has
 * to agree with the rows the chat's queued bar lists. Driven through the real
 * routes, SQLite and SessionQueue with a turn held open, because the in-process
 * chain only shrinks when a cancelled row's slot is reached.
 */

beforeEach(resetCallbackState);

const HEADERS = { host: "gateway.test", authorization: "Bearer test-token", "content-type": "application/json" };

function blockingEngine() {
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

async function request(context: ApiContext, method: string, url: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: HEADERS,
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

const send = (context: ApiContext, sessionId: string, message: string) =>
  request(context, "POST", `/api/sessions/${sessionId}/message`, { message });

const parkedRows = async (context: ApiContext, sessionId: string) =>
  ((await request(context, "GET", `/api/sessions/${sessionId}/queue`)).body as Array<{ id: string; prompt: string; status: string }>)
    .filter((row) => row.status === "pending");

const depthOf = async (context: ApiContext, sessionId: string) => {
  const listed = (await request(context, "GET", "/api/sessions")).body as { sessions: Array<{ id: string; queueDepth: number }> };
  return listed.sessions.find((row) => row.id === sessionId)?.queueDepth;
};

/** One running turn plus `parked` messages waiting behind it. */
async function sessionWithParkedMessages(parked: string[], suffix: string) {
  const { engine, prompts, release } = blockingEngine();
  const queue = new queueModule.SessionQueue();
  const context = makeContext(engine, queue, []);
  const session = createParent(suffix);
  await send(context, session.id, "running turn");
  await eventually(() => expect(prompts).toEqual(["running turn"]));
  for (const message of parked) await send(context, session.id, message);
  expect((await parkedRows(context, session.id)).map((row) => row.prompt)).toEqual(parked);
  return { context, queue, session, prompts, release };
}

describe("the session list's queue badge", () => {
  it("drops a cancelled message at once, not when the running turn ends", async () => {
    const { context, session, prompts, release } = await sessionWithParkedMessages(["keep me", "cancel me"], "badge-cancel");
    expect(await depthOf(context, session.id)).toBe(2);
    const doomed = (await parkedRows(context, session.id)).find((row) => row.prompt === "cancel me")!;

    expect((await request(context, "DELETE", `/api/sessions/${session.id}/queue/${doomed.id}`)).status).toBe(200);

    expect(await depthOf(context, session.id)).toBe((await parkedRows(context, session.id)).length);
    expect(await depthOf(context, session.id)).toBe(1);

    // A message queued afterwards counts once, against the one still parked.
    await send(context, session.id, "added later");
    expect(await depthOf(context, session.id)).toBe(2);

    release();
    await eventually(() => expect(prompts).toEqual(["running turn", "keep me", "added later"]));
    await eventually(async () => expect(await depthOf(context, session.id)).toBe(0));
  });

  it("drops every parked message when the queue is cleared", async () => {
    const { context, session, release } = await sessionWithParkedMessages(["one", "two", "three"], "badge-clear");
    expect(await depthOf(context, session.id)).toBe(3);

    expect((await request(context, "DELETE", `/api/sessions/${session.id}/queue`)).status).toBe(200);

    expect(await depthOf(context, session.id)).toBe(0);
    release();
  });

  it("still counts turns that have no durable row, such as a connector message", async () => {
    const { context, queue, session, release } = await sessionWithParkedMessages(["parked with a row"], "badge-rowless");
    const key = session.sessionKey || session.sourceRef;
    // A connector turn goes straight into the in-process chain, behind the running one.
    const started: string[] = [];
    void queue.enqueue(key, async () => { started.push("connector"); });
    expect(await depthOf(context, session.id)).toBe(2);

    const doomed = (await parkedRows(context, session.id))[0];
    expect((await request(context, "DELETE", `/api/sessions/${session.id}/queue/${doomed.id}`)).status).toBe(200);
    expect(await depthOf(context, session.id)).toBe(1);

    release();
    await eventually(() => expect(started).toEqual(["connector"]));
    await eventually(async () => expect(await depthOf(context, session.id)).toBe(0));
  });
});
