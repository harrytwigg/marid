import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * GET /api/work-items/:id/sessions — the flat list, and `?tree=1`.
 *
 * The tree shape was added to this route rather than to a new one, so the first
 * thing this suite pins is that the DEFAULT response did not move: the Todo
 * page's own live/dispatcher derivations and the talk surface both read the
 * flat array, and a widened default would break them silently.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-tree-route-"));
process.env.JINN_HOME = tmpHome;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;

const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } }, sessions: {}, mcp: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_k: string, s: string) => s }),
  },
} as unknown as import("../api.js").ApiContext;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

async function get(urlPath: string): Promise<{ status: number; body: any }> {
  const req = Object.assign(Readable.from([]), {
    method: "GET",
    url: urlPath,
    headers: { host: "localhost", authorization: "Bearer test-token" },
  });
  const cap = makeRes();
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
  return { status: cap.status, body: cap.body };
}

function session(id: string, opts: { employee?: string; parentSessionId?: string } = {}): string {
  return reg.createSession({
    engine: "codex",
    source: "web",
    sourceRef: `web:${id}`,
    sessionKey: `web:${id}`,
    connector: "web",
    prompt: `work for ${id}`,
    title: id,
    ...opts,
  }).id;
}

let todoId: string;
let otherTodoId: string;
let rootSessionId: string;
let childSessionId: string;
let reviewerSessionId: string;
let creatorSessionId: string;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");

  // A Todo minted BY a session that never works it — the reported symptom: the
  // rail printed this id as text because the session is not in the tree.
  creatorSessionId = session("creator", { employee: "coo" });
  todoId = store.createWorkItem({ title: "Tree root todo", createdBy: `session:${creatorSessionId}` }).id;
  otherTodoId = store.createWorkItem({ title: "Delegated todo" }).id;

  rootSessionId = session("root", { employee: "todo-dispatcher" });
  store.linkSession(todoId, rootSessionId, "operator");

  // A delegation: child session under the root, tracking a Todo of its own.
  childSessionId = session("child", { employee: "senior-developer", parentSessionId: rootSessionId });
  store.linkSession(otherTodoId, childSessionId, "operator");

  // A review hand-off onto the SAME Todo — linked with the review role.
  reviewerSessionId = session("reviewer", { employee: "qa-emp", parentSessionId: rootSessionId });
  store.linkSession(todoId, reviewerSessionId, "operator", "review");
});

describe("GET /api/work-items/:id/sessions", () => {
  it("still answers the flat array when tree is not asked for", async () => {
    const resp = await get(`/api/work-items/${todoId}/sessions`);

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body)).toBe(true);
    expect(resp.body.map((s: { id: string }) => s.id).sort()).toEqual([reviewerSessionId, rootSessionId].sort());
  });

  it("answers the tree under ?tree=1, nesting a delegation under its parent", async () => {
    const resp = await get(`/api/work-items/${todoId}/sessions?tree=1`);

    expect(resp.status).toBe(200);
    expect(resp.body.roots.map((n: { id: string }) => n.id).sort()).toEqual([reviewerSessionId, rootSessionId].sort());
    const root = resp.body.roots.find((n: { id: string }) => n.id === rootSessionId);
    expect(root.children.map((n: { id: string }) => n.id)).toEqual([childSessionId]);
    expect(root.children[0].workItemId).toBe(otherTodoId);
  });

  it("carries the review role a delegation onto the Todo recorded", async () => {
    const resp = await get(`/api/work-items/${todoId}/sessions?tree=1`);

    const reviewer = resp.body.roots.find((n: { id: string }) => n.id === reviewerSessionId);
    const worker = resp.body.roots.find((n: { id: string }) => n.id === rootSessionId);
    expect(reviewer.role).toBe("review");
    expect(worker.role).toBe("execute");
  });

  it("resolves the creating session even though it is not linked to the Todo", async () => {
    const resp = await get(`/api/work-items/${todoId}/sessions?tree=1`);

    expect(resp.body.roots.flatMap((n: { id: string }) => n.id)).not.toContain(creatorSessionId);
    expect(resp.body.directory[creatorSessionId]).toMatchObject({ employee: "coo", missing: false });
  });

  it("returns an empty tree for a Todo nothing is linked to", async () => {
    const empty = store.createWorkItem({ title: "Untouched" }).id;
    const resp = await get(`/api/work-items/${empty}/sessions?tree=1`);

    expect(resp.body.roots).toEqual([]);
    expect(resp.body.totals).toEqual({ nodes: 0, live: 0 });
  });

  it("writes nothing — the tree is a read surface", async () => {
    const before = store.getWorkItem(todoId)!.updatedAt;
    await get(`/api/work-items/${todoId}/sessions?tree=1`);

    expect(store.getWorkItem(todoId)!.updatedAt).toBe(before);
    expect(reg.getSession(rootSessionId)!.workItemId).toBe(todoId);
  });
});
