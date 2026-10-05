import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";
import { mentionTestHome } from "./todo-mentions-harness.js";

/**
 * A long session whose prompt cache has gone cold, woken by an @mention on a
 * Todo, is compacted before the mention runs — the same as any other message.
 *
 * Driven from the comment through every hop a real wake takes: the comment
 * routing finds the employee's live session, the outbox claims the delivery
 * and posts it to the message route as a notification, the route accepts and
 * queues it, and the turn it queued runs through `runTurn`. Nothing on that path
 * may touch what the coldness decision reads: when the engine conversation was
 * last synced, when a terminal-typed turn was, or the context meter.
 */

const home = mentionTestHome("jinn-mention-cold-wake-");
fs.writeFileSync(path.join(home, "org", "sleeper.yaml"), [
  "name: sleeper", "displayName: Sleeper", "department: platform", "rank: employee", "reportsTo: org-root",
  "engine: claude", "model: opus", "persona: sleeper for cold-wake tests", "",
].join("\n"));

vi.mock("../../sessions/callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://gateway.test" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json", authorization: "Bearer test-token" }),
}));
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

const MINUTE = 60_000;
const AUTO_COMPACT = { enabled: true, cacheWindowSeconds: 300, minContextTokens: 50_000 };

const config = {
  gateway: {},
  engines: { default: "claude", claude: { bin: "claude", model: "opus", autoCompact: AUTO_COMPACT } },
  models: { claude: { default: "opus", models: [{ id: "opus" }] } },
  sessions: {},
} as unknown as JinnConfig;

/** Turns the route queues, held instead of run, so the test runs each itself. */
const queued: Array<() => Promise<unknown>> = [];
const idleEngine: Engine = { name: "claude", run: async () => ({ sessionId: "", result: "" }) };
/** The engine the queued turns run on. */
let claude: Engine = idleEngine;
const context = {
  getConfig: () => config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  sessionManager: {
    getEngines: () => new Map([["claude", claude]]),
    getEngine: (name: string) => (name === "claude" ? claude : undefined),
    getQueue: () => ({
      enqueue: async (_key: string, fn: () => Promise<unknown>) => { queued.push(fn); },
      clearCancelled: () => {},
      clearQueue: () => {},
      holdForCallbackDrain: () => {},
      releaseCallbackDrain: () => {},
      hasInFlightItem: () => false,
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

type Modules = {
  api: typeof import("../api.js");
  reg: typeof import("../../sessions/registry.js");
  store: typeof import("../../work-items/store.js");
  comments: typeof import("../../work-items/comment-add.js");
  routing: typeof import("../todo-comment-routing.js");
};
let m: Modules;

beforeAll(async () => {
  m = {
    api: await import("../api.js"),
    reg: await import("../../sessions/registry.js"),
    store: await import("../../work-items/store.js"),
    comments: await import("../../work-items/comment-add.js"),
    routing: await import("../todo-comment-routing.js"),
  };
  (await import("../../shared/db.js")).initDb();
  // The outbox's HTTP hop, served in-process by the real route.
  globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const req = Object.assign(Readable.from([Buffer.from(init.body)]), {
      method: init.method,
      url: new URL(url).pathname,
      headers: { host: "localhost", ...Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])) },
    });
    let status = 200;
    const res = {
      writeHead(next: number) { status = next; return this; },
      setHeader() { return this; },
      end() {},
    } as unknown as ServerResponse;
    await m.api.handleApiRequest(req as unknown as Parameters<typeof m.api.handleApiRequest>[0], res, context);
    return { ok: status < 400, status };
  }) as unknown as typeof fetch;
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

function mention(todoId: string, body: string) {
  const comment = m.comments.addComment({ workItemId: todoId, authorKind: "operator", author: "operator", body });
  return m.routing.routeTodoComment(context, comment);
}

/** What the coldness decision reads off the row, nothing else. */
function coldnessInputs(sessionId: string) {
  const live = m.reg.getSession(sessionId)!;
  return {
    lastSyncedAt: m.reg.getEngineSessionRef(live, "claude").lastSyncedAt,
    transcriptActivityAt: (live.transportMeta as Record<string, unknown> | null)?.transcriptActivityAt,
    lastContextTokens: live.lastContextTokens,
  };
}

describe("an @mention waking a long, cache-cold session", () => {
  it("leaves every coldness input alone on the way in, and the turn compacts before the mention runs", async () => {
    const item = m.store.createWorkItem({ title: "cold wake" });
    // The first mention starts sleeper's session on the Todo.
    const [first] = mention(item.id, "@sleeper have a look");
    expect(first?.started).toBe(true);
    queued.length = 0;
    const sessionId = first!.sessionId;

    // Long ago it ran a long conversation, and has sat idle since.
    const longAgo = new Date(Date.now() - 45 * MINUTE).toISOString();
    m.reg.recordEngineSessionId(sessionId, "claude", "claude-thread-1", { model: "opus", lastSyncedAt: longAgo });
    m.reg.updateSession(sessionId, {
      status: "idle",
      lastContextTokens: 180_000,
      transportMeta: { ...(m.reg.getSession(sessionId)!.transportMeta ?? {}), transcriptActivityAt: longAgo } as never,
    });
    const before = coldnessInputs(sessionId);

    const [wake] = mention(item.id, "@sleeper any news?");
    expect(wake).toMatchObject({ sessionId, started: false });
    await until(() => queued.length === 1);

    // Delivered as a notification into the same session, and nothing it
    // touched on the way moved what the decision reads.
    const notification = m.reg.getMessages(sessionId).filter((msg) => msg.role === "notification").at(-1);
    expect(notification?.content).toContain("any news?");
    expect(coldnessInputs(sessionId)).toEqual(before);

    // The queued turn runs: the compaction first, then the mention, on the thread it compacted.
    const prompts: string[] = [];
    const engine: Engine = {
      name: "claude",
      async run(opts): Promise<EngineResult> {
        prompts.push(opts.prompt);
        return prompts.length === 1
          ? { sessionId: "claude-thread-1", result: "", compaction: { preTokens: 180_000, postTokens: 9_000 }, contextTokens: 9_000 }
          : { sessionId: "claude-thread-1", result: "no news yet", contextTokens: 11_000 };
      },
    };
    claude = engine;
    await queued[0]();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toMatch(/^\/compact /);
    expect(prompts[1]).toContain("any news?");
    expect(m.reg.getSession(sessionId)!.lastContextTokens).toBe(11_000);
  });
});
