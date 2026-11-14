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
 * "Send this one now" promotes a parked message without touching what it is: its
 * queue item id, its bubble and the way it was sent (chat or CLI view) all stay
 * with it. Real route handler, real SQLite, real SessionQueue.
 */

beforeEach(resetCallbackState);

const HEADERS = {
  host: "gateway.test",
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

async function request(context: ApiContext, method: string, url: string, body?: unknown) {
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

interface QueueRow { id: string; prompt: string; status: string; messageId: string | null }

const parkedRows = async (context: ApiContext, sessionId: string): Promise<QueueRow[]> =>
  ((await request(context, "GET", `/api/sessions/${sessionId}/queue`)).body as QueueRow[])
    .filter((row) => row.status === "pending");

/** An engine whose turns do not finish until the test releases them, so messages park. */
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

/** One running turn plus `parked` messages waiting behind it. */
async function sessionWithParkedMessages(parked: string[], suffix: string) {
  const { engine, prompts, release } = blockingEngine();
  const context = makeContext(engine, new queueModule.SessionQueue(), []);
  const session = createParent(suffix);
  await send(context, session.id, "running turn");
  await eventually(() => expect(prompts).toEqual(["running turn"]));
  for (const message of parked) await send(context, session.id, message);
  return { context, session, prompts, release };
}

describe("a promoted message keeps its own row", () => {
  it("keeps every pending row's id bound to the message it was created for", async () => {
    const { context, session, release, prompts } = await sessionWithParkedMessages(
      ["first parked", "second parked", "third parked"],
      "ids-stable",
    );
    const before = await parkedRows(context, session.id);
    const byId = new Map(before.map((row) => [row.id, { prompt: row.prompt, messageId: row.messageId }]));
    const third = before.find((row) => row.prompt === "third parked")!;

    await request(context, "POST", `/api/sessions/${session.id}/queue/${third.id}/send-now`);

    const after = await parkedRows(context, session.id);
    expect(after.map((row) => row.prompt)).toEqual(["third parked", "first parked", "second parked"]);
    for (const row of after) expect({ prompt: row.prompt, messageId: row.messageId }).toEqual(byId.get(row.id));
    // The transcript bubble each row points at still shows that row's own text.
    for (const row of after) {
      expect(registry.getMessages(session.id).find((message) => message.id === row.messageId)?.content).toBe(row.prompt);
    }
    release();
    await eventually(() => expect(prompts).toHaveLength(4));
  });

  it("runs a promoted CLI-view message interactively even when the row it displaced was a chat send", async () => {
    const { engine, prompts, release } = blockingEngine();
    const interactive: string[] = [];
    const headlessRunsBefore: number[] = [];
    const ptyEngine = {
      name: "stub",
      run: async (opts: EngineRunOpts) => {
        interactive.push(opts.prompt);
        headlessRunsBefore.push(prompts.length);
        return { sessionId: "stub", result: "acknowledged" };
      },
    } as unknown as Engine;
    const queue = new queueModule.SessionQueue();
    const context = makeContext(engine, queue, []);
    (context as { ptyViewEngines?: unknown }).ptyViewEngines = { stub: ptyEngine };
    const session = createParent("send-now-mode");
    await send(context, session.id, "running turn");
    await eventually(() => expect(prompts).toEqual(["running turn"]));
    await send(context, session.id, "chat view send");
    await request(context, "POST", `/api/sessions/${session.id}/message`, { message: "cli view send", mode: "interactive" });
    const cli = (await parkedRows(context, session.id)).find((row) => row.prompt === "cli view send")!;

    await request(context, "POST", `/api/sessions/${session.id}/queue/${cli.id}/send-now`);
    release();

    await eventually(() => expect(prompts).toEqual(["running turn", "chat view send"]));
    expect(interactive).toEqual(["cli view send"]);
    // It ran next: only the interrupted-in-waiting turn had started on the headless engine.
    expect(headlessRunsBefore).toEqual([1]);
  });
});
