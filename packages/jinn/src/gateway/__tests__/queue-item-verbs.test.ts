import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import type { Engine, EngineRunOpts } from "../../shared/types.js";

/**
 * The two verbs a parked message card offers beyond cancel: edit it
 * in place, and jump it to the front. Both run against the real route handler,
 * real SQLite and a real SessionQueue, because what they have to get right is
 * the relationship between a durable row, the transcript row it shows, and the
 * text the engine is eventually handed.
 */

beforeEach(resetCallbackState);

const HEADERS = {
  host: "gateway.test",
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

/** An engine whose turn does not finish until the test releases it, so messages park. */
interface RunRecord { prompt: string; attachments: string[] }

function blockingEngine(): { engine: Engine; runs: RunRecord[]; prompts: string[]; release: () => void } {
  const runs: RunRecord[] = [];
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine: Engine = {
    name: "stub",
    run: async (opts: EngineRunOpts) => {
      runs.push({ prompt: opts.prompt, attachments: opts.attachments ?? [] });
      prompts.push(opts.prompt);
      await gate;
      return { sessionId: "stub", result: "acknowledged" };
    },
  };
  return { engine, runs, prompts, release: () => release() };
}

async function request(
  context: ApiContext,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { ...HEADERS, ...headers },
  });
  const captured = makeResponse();
  await api.handleApiRequest(req as never, captured.res, context);
  return captured;
}

const send = (context: ApiContext, sessionId: string, message: string) =>
  request(context, "POST", `/api/sessions/${sessionId}/message`, { message });

interface QueueRow {
  id: string;
  prompt: string;
  status: string;
  messageId: string | null;
}

const readQueue = async (context: ApiContext, sessionId: string): Promise<QueueRow[]> =>
  (await request(context, "GET", `/api/sessions/${sessionId}/queue`)).body as QueueRow[];

/** Parked rows in the order they will run. The running row shares a `position`
 *  with the first pending one, so index into the raw list is not order. */
const parkedRows = async (context: ApiContext, sessionId: string) =>
  (await readQueue(context, sessionId)).filter((row) => row.status === "pending");

const runningRow = async (context: ApiContext, sessionId: string) =>
  (await readQueue(context, sessionId)).find((row) => row.status === "running")!;

/** One running turn plus `parked` messages waiting behind it. */
async function sessionWithParkedMessages(parked: string[], suffix: string) {
  const { engine, runs, prompts, release } = blockingEngine();
  const queue = new queueModule.SessionQueue();
  const context = makeContext(engine, queue, []);
  const session = createParent(suffix);
  await send(context, session.id, "running turn");
  await eventually(() => expect(prompts).toEqual(["running turn"]));
  for (const message of parked) await send(context, session.id, message);
  expect((await parkedRows(context, session.id)).map((row) => row.prompt)).toEqual(parked);
  return { context, queue, session, runs, prompts, release };
}

describe("PATCH /api/sessions/:id/queue/:itemId", () => {
  it("rewrites the row, the bubble, and the text the engine is handed", async () => {
    const { context, session, prompts, release } = await sessionWithParkedMessages(["draft the digest"], "edit");
    const [parked] = await parkedRows(context, session.id);

    const patched = await request(context, "PATCH", `/api/sessions/${session.id}/queue/${parked.id}`, {
      prompt: "draft the digest and post it",
    });

    expect(patched.status).toBe(200);
    expect((await parkedRows(context, session.id))[0].prompt).toBe("draft the digest and post it");
    expect(registry.getMessages(session.id).find((message) => message.id === parked.messageId)?.content)
      .toBe("draft the digest and post it");

    release();
    await eventually(() => expect(prompts).toEqual(["running turn", "draft the digest and post it"]));
  });

  it("refuses an item that is already running, and changes nothing", async () => {
    const { context, session } = await sessionWithParkedMessages(["parked"], "edit-running");
    const running = await runningRow(context, session.id);

    const refused = await request(context, "PATCH", `/api/sessions/${session.id}/queue/${running.id}`, {
      prompt: "too late",
    });

    expect(refused.status).toBe(409);
    expect((await runningRow(context, session.id)).prompt).toBe("running turn");
    expect(registry.getMessages(session.id).find((message) => message.id === running.messageId)?.content)
      .toBe("running turn");
  });

  it("refuses an empty prompt", async () => {
    const { context, session } = await sessionWithParkedMessages(["parked"], "edit-empty");
    const [parked] = await parkedRows(context, session.id);

    const refused = await request(context, "PATCH", `/api/sessions/${session.id}/queue/${parked.id}`, { prompt: "   " });

    expect(refused.status).toBe(400);
    expect((await parkedRows(context, session.id))[0].prompt).toBe("parked");
  });
});

describe("POST /api/sessions/:id/queue/:itemId/send-now", () => {
  it("runs the third parked message first and keeps the other two in order", async () => {
    const { context, session, prompts, release } = await sessionWithParkedMessages(
      ["first parked", "second parked", "third parked"],
      "send-now",
    );
    const third = (await parkedRows(context, session.id)).find((row) => row.prompt === "third parked")!;

    const promoted = await request(context, "POST", `/api/sessions/${session.id}/queue/${third.id}/send-now`);

    expect(promoted.status).toBe(200);
    // Nothing is cancelled: the whole chain still has to drain, just in a new order.
    const after = await readQueue(context, session.id);
    expect(after).toHaveLength(4);
    expect(after.filter((row) => row.status === "pending")).toHaveLength(3);
    expect((await parkedRows(context, session.id)).map((row) => row.prompt))
      .toEqual(["third parked", "first parked", "second parked"]);

    release();
    await eventually(() => expect(prompts).toEqual([
      "running turn",
      "third parked",
      "first parked",
      "second parked",
    ]));
  });

  it("carries the promoted message's own attachment, not the one from the row it lands on", async () => {
    const { engine, runs, prompts, release } = blockingEngine();
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue, []);
    const session = createParent("send-now-attachments");
    await send(context, session.id, "running turn");
    await eventually(() => expect(prompts).toEqual(["running turn"]));

    // The head row is enqueued with a file; the one behind it carries none. Send-now
    // moves the second payload onto the first row, and the file must not come with it.
    const onDisk = path.join(os.tmpdir(), `jinn-queue-verbs-${Date.now()}.png`);
    fs.writeFileSync(onDisk, "png");
    registry.insertFile({ id: "file-chart", filename: "chart.png", size: 3, mimetype: "image/png", path: onDisk });
    await request(context, "POST", `/api/sessions/${session.id}/message`, {
      message: "look at the chart", attachments: ["file-chart"],
    });
    await send(context, session.id, "no attachment here");
    const plain = (await parkedRows(context, session.id)).find((row) => row.prompt === "no attachment here")!;

    await request(context, "POST", `/api/sessions/${session.id}/queue/${plain.id}/send-now`);

    release();
    await eventually(() => expect(runs).toHaveLength(3));
    expect(runs[1].prompt).toBe("no attachment here");
    expect(runs[1].attachments).toEqual([]);
    expect(runs[2].prompt).toBe("look at the chart");
    expect(runs[2].attachments).toHaveLength(1);
  });

  it("does not clear the queue — the regression POST /stop would introduce", async () => {
    const { context, queue, session } = await sessionWithParkedMessages(["first parked", "second parked"], "no-clear");
    const clearQueue = vi.spyOn(queue, "clearQueue");
    const [first] = await parkedRows(context, session.id);

    await request(context, "POST", `/api/sessions/${session.id}/queue/${first.id}/send-now`);

    expect(clearQueue).not.toHaveBeenCalled();
  });

  it("is a no-op on the head of the queue", async () => {
    const { context, session, prompts, release } = await sessionWithParkedMessages(["first parked", "second parked"], "head");
    const [first] = await parkedRows(context, session.id);

    await request(context, "POST", `/api/sessions/${session.id}/queue/${first.id}/send-now`);

    expect((await parkedRows(context, session.id)).map((row) => row.prompt))
      .toEqual(["first parked", "second parked"]);
    release();
    await eventually(() => expect(prompts).toEqual(["running turn", "first parked", "second parked"]));
  });
});

describe("GET /api/sessions/:id/queue", () => {
  it("links a row enqueued through POST /message to its transcript row, and leaves other paths null", async () => {
    const { context, session } = await sessionWithParkedMessages(["parked"], "message-id");
    registry.enqueueQueueItem(session.id, session.sessionKey, "enqueued with no message");

    const items = await readQueue(context, session.id);

    const parked = items.find((row) => row.prompt === "parked")!;
    expect(parked.messageId).toEqual(expect.any(String));
    expect(registry.getMessages(session.id).find((message) => message.id === parked.messageId)?.content)
      .toBe("parked");
    expect(items.find((row) => row.prompt === "enqueued with no message")!.messageId).toBeNull();
  });
});

describe("operator-only control-plane authority", () => {
  it("refuses both verbs to a capability-bound employee session", async () => {
    const { context, session } = await sessionWithParkedMessages(["parked"], "authority");
    const [parked] = await parkedRows(context, session.id);
    const worker = createParent("authority-worker");
    const asWorker = {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: worker.id,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(worker.id),
    };

    const edit = await request(
      context, "PATCH", `/api/sessions/${session.id}/queue/${parked.id}`, { prompt: "rewritten" }, asWorker,
    );
    const promote = await request(
      context, "POST", `/api/sessions/${session.id}/queue/${parked.id}/send-now`, {}, asWorker,
    );

    for (const refused of [edit, promote]) {
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toMatch(/operator.*control-plane/i);
    }
    expect((await parkedRows(context, session.id))[0].prompt).toBe("parked");
  });
});
