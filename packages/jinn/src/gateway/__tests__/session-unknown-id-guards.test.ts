import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * A session id that names no row is an error, not an empty result.
 *
 * Two routes used to accept one silently: `/children` answered `200 []`, which
 * a caller cannot tell apart from a real session that simply has no children,
 * and the spawn route persisted an operator-supplied `parentSessionId` pointing
 * at nothing, producing a child whose lineage dead-ends.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-unknown-id-guards-"));
process.env.JINN_HOME = tmpHome;
fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const ctx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    sessions: {},
    mcp: { browser: { enabled: false }, gateway: { enabled: false } },
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => ({
      enqueue: async () => {},
      clearCancelled: () => {},
      clearQueue: () => {},
      getPendingCount: () => 0, getRowlessWaitingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

async function get(pathAndQuery: string) {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: pathAndQuery,
    headers: { host: "localhost" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, ctx);
  return cap;
}

async function spawnAsOperator(body: Record<string, unknown>) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: "/api/sessions",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, ctx);
  return cap;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).initDb();
});

describe("GET /api/sessions/:id/children", () => {
  it("returns 404 for a session id that does not exist", async () => {
    const cap = await get("/api/sessions/no-such-session/children");

    expect(cap.status).toBe(404);
    expect(cap.body).toEqual({ error: "Not found" });
  });

  it("still returns an empty list for a real session with no children", async () => {
    const lonely = reg.createSession({ engine: "codex", source: "web", sourceRef: "children-lonely" });

    const cap = await get(`/api/sessions/${lonely.id}/children`);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });

  it("still lists the children of a session that has them", async () => {
    const parent = reg.createSession({ engine: "codex", source: "web", sourceRef: "children-parent" });
    const child = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "children-child",
      parentSessionId: parent.id,
    });

    const cap = await get(`/api/sessions/${parent.id}/children`);

    expect(cap.status).toBe(200);
    expect((cap.body as Array<{ id: string }>).map((s) => s.id)).toEqual([child.id]);
  });
});

describe("POST /api/sessions — operator-supplied parentSessionId", () => {
  it("rejects a parent that does not exist, and persists nothing", async () => {
    const before = reg.listSessions().length;

    const cap = await spawnAsOperator({ prompt: "adopt me", parentSessionId: "no-such-parent" });

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/unknown parentSessionId/i);
    expect(reg.listSessions().length).toBe(before);
  });

  it("honours a parent that does exist", async () => {
    const parent = reg.createSession({ engine: "codex", source: "web", sourceRef: "spawn-real-parent" });

    const cap = await spawnAsOperator({ prompt: "adopt me properly", parentSessionId: parent.id });

    expect(cap.status).toBe(201);
    expect(reg.getSession(cap.body.id as string)!.parentSessionId).toBe(parent.id);
  });
});
