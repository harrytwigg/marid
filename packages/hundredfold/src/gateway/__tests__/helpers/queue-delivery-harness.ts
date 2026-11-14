// The queue delivery routes driven against the real route handler, a real
// SessionQueue and real SQLite, with an engine whose turn ends only when it is
// released or killed. Shared by queue-delivery.test.ts.
import { Readable } from "node:stream";
import { expect } from "vitest";
import { api, createParent, eventually, makeContext, queueModule, type ApiContext } from "./callback-harness.js";
import { makeResponse } from "./callback-requests.js";
import type { Engine, EngineRunOpts } from "../../../shared/types.js";

const HEADERS = {
  host: "gateway.test",
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

export async function request(
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

export const send = (context: ApiContext, sessionId: string, message: string, extra: Record<string, unknown> = {}) =>
  request(context, "POST", `/api/sessions/${sessionId}/message`, { message, ...extra });

export interface QueueRow { id: string; prompt: string; status: string }

export const parkedRows = async (context: ApiContext, sessionId: string): Promise<QueueRow[]> =>
  ((await request(context, "GET", `/api/sessions/${sessionId}/queue`)).body as QueueRow[])
    .filter((row) => row.status === "pending");

export const transcriptTexts = async (context: ApiContext, sessionId: string): Promise<string[]> =>
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

export async function runningInterruptibleSession(suffix: string) {
  const stub = interruptibleBlockingEngine();
  const queue = new queueModule.SessionQueue();
  const events: Array<{ event: string; data: unknown }> = [];
  const context = makeContext(stub.engine, queue, events);
  const session = createParent(suffix);
  await send(context, session.id, "running turn");
  await eventually(() => expect(stub.prompts).toEqual(["running turn"]));
  return { ...stub, context, queue, session, events };
}
