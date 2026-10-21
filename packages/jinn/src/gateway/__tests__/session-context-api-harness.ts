import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { ensureSessionCapability } from "../../mcp/identity.js";
import type { Session } from "../../shared/types.js";

/**
 * A real gateway API, registry and queue rows (temp JINN_HOME) for the context
 * meter's route tests. As in the self-compaction route tests, the route's own
 * loopback through the message route is served in-process by routing `fetch`
 * back into handleApiRequest, so what is asserted is what a live gateway would
 * have queued. JINN_HOME is set when this module loads, before any of the
 * modules that read it are imported (they are imported in `beforeAll`).
 */

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-context-meter-api-home-"));

type Api = typeof import("../api.js");

function makeRes() {
  const chunks: Buffer[] = [];
  const cap = {
    status: 0,
    res: {
      writeHead(status: number) {
        cap.status = status;
        return cap.res;
      },
      setHeader() {},
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      headersSent: false,
    } as unknown as ServerResponse,
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
  return cap;
}

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  holdForCallbackDrain: () => {},
  releaseCallbackDrain: () => {},
  hasInFlightItem: () => false,
  getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => true,
  isTurnRunning: () => true,
  kill: () => {},
  killAll: () => {},
};

let counter = 0;

export function useContextMeterHarness() {
  let api: Api;
  let opencodeMode: "run" | "server" = "server";
  let engineConfig: Record<string, unknown> = {};
  let loopbacks: Array<{ path: string; body: Record<string, unknown> }> = [];
  let failLoopback = false;
  const apiCtx = {
    getConfig: () => ({ gateway: {}, engines: { default: "claude", opencode: { mode: opencodeMode }, ...engineConfig }, sessions: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    sessionManager: {
      getEngines: () => new Map([["claude", engineStub], ["opencode", engineStub], ["codex", engineStub]]),
      getEngine: () => engineStub,
      getQueue: () => queueStub,
    },
  } as unknown as import("../api.js").ApiContext;

  const h = {
    apiCtx,
    registry: undefined as unknown as typeof import("../../sessions/registry.js"),
    queueItems: undefined as unknown as typeof import("../../sessions/queue-item-registry.js"),
    autoCompaction: undefined as unknown as typeof import("../../sessions/auto-compaction.js"),
    availability: undefined as unknown as typeof import("../session-context-api.js"),
    db: undefined as unknown as typeof import("../../shared/db.js"),
    loopbacks: () => loopbacks,
    setFailLoopback: (fail: boolean) => { failLoopback = fail; },
    setOpencodeMode: (mode: "run" | "server") => { opencodeMode = mode; },
    setEngineConfig: (config: Record<string, unknown>) => { engineConfig = config; },

    async request(
      method: string,
      pathAndQuery: string,
      opts: { headers?: Record<string, string>; body?: unknown } = {},
    ): Promise<{ status: number; body: any }> {
      const raw = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
        method,
        url: pathAndQuery,
        headers: {
          host: "gateway.test",
          authorization: "Bearer test-token",
          ...(raw ? { "content-type": "application/json" } : {}),
          ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        },
      });
      const cap = makeRes();
      await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
      let body: any = cap.text;
      try {
        body = JSON.parse(cap.text);
      } catch { /* non-JSON body */ }
      return { status: cap.status, body };
    },

    asSession(sessionId: string): Record<string, string> {
      return {
        "x-jinn-tool-call": "jinn-mcp",
        "x-jinn-caller-session": sessionId,
        "x-jinn-session-capability": ensureSessionCapability(sessionId)!,
      };
    },

    /** An idle chat on `engine`, with a conversation to compact unless `conversation` is false. */
    newSession(engine: string, opts: { conversation?: boolean; parentSessionId?: string; source?: string } = {}): Session {
      counter += 1;
      const session = h.registry.createSession({
        engine,
        source: opts.source ?? "web",
        sourceRef: `context-meter-${counter}`,
        ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      });
      if (opts.conversation !== false && engine !== "terminal") h.registry.recordEngineSessionId(session.id, engine, `${engine}-thread-${counter}`, {});
      return h.registry.getSession(session.id)!;
    },

    /** Every pending turn row, internal (notification-role) ones included. */
    pendingPrompts: (id: string): string[] => (h.db.initDb()
      .prepare("SELECT prompt FROM queue_items WHERE session_id = ? AND status = 'pending' ORDER BY position ASC, created_at ASC")
      .all(id) as Array<{ prompt: string }>).map((row) => row.prompt),

    /** The turn has run: nothing is pending or running any more. */
    finishQueue: (id: string): void => {
      h.db.initDb().prepare("UPDATE queue_items SET status = 'completed' WHERE session_id = ?").run(id);
    },

    selfCompactionAt: (id: string) => h.registry.getSession(id)!.transportMeta?.selfCompactionAt,
  };

  beforeAll(async () => {
    api = await import("../api.js");
    h.registry = await import("../../sessions/registry.js");
    h.queueItems = await import("../../sessions/queue-item-registry.js");
    h.autoCompaction = await import("../../sessions/auto-compaction.js");
    h.availability = await import("../session-context-api.js");
    h.db = await import("../../shared/db.js");
    const models = await import("../../shared/models.js");
    models.setDiscoveredClaudeModelsForTest({
      defaultModel: "opus",
      models: [
        { id: "opus", label: "Opus (Latest)", supportsEffort: true, effortLevels: [], contextWindow: 200_000 },
        { id: "sonnet", label: "Sonnet (Latest)", supportsEffort: true, effortLevels: [] },
      ],
    });
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      loopbacks.push({ path: url.pathname, body });
      if (failLoopback) return new Response(JSON.stringify({ error: "simulated" }), { status: 503 });
      const out = await h.request(init?.method ?? "GET", url.pathname + url.search, { body });
      return new Response(JSON.stringify(out.body), { status: out.status });
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    (await import("../../shared/models.js")).setDiscoveredClaudeModelsForTest(null);
  });

  beforeEach(() => {
    loopbacks = [];
    failLoopback = false;
    opencodeMode = "server";
    engineConfig = {};
  });

  return h;
}
