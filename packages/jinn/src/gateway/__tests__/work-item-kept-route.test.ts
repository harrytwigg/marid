import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  ensureSessionCapability,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
} from "../../mcp/identity.js";

/**
 * `PUT /api/work-items/:id/kept`. Home is the operator's board, so
 * only the operator may put anything on it; everything else about the route is
 * the ordinary work-item sub-path contract (400 bad id, 404 unknown, 400 bad
 * body). Drives handleApiRequest directly against a throwaway JINN_HOME.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-kept-route-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Route-test worker.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Kept = typeof import("../../work-items/kept.js");
let api: Api;
let reg: Reg;
let store: Store;
let kept: Kept;
let db: import("better-sqlite3").Database;

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

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
  sessionManager: {
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

const operatorHeaders = { authorization: "Bearer test-token" };

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, urlPath, body, headers), cap.res, ctx);
  return cap;
}

const keptOf = (id: string) => kept.isWorkItemKept(db, id);

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  kept = await import("../../work-items/kept.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("PUT /api/work-items/:id/kept", () => {
  it("keeps an agent-created Todo for the operator, and unkeeps it again", async () => {
    const item = store.createWorkItem({ title: "raised by an agent", createdBy: "session:agent-1" });
    expect(keptOf(item.id)).toBe(false);

    const on = await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, operatorHeaders);
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ kept: true });
    expect(keptOf(item.id)).toBe(true);

    const off = await call("PUT", `/api/work-items/${item.id}/kept`, { kept: false }, operatorHeaders);
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ kept: false });
    expect(keptOf(item.id)).toBe(false);
  });

  it("records one kept_changed event per real change, and none for a repeat", async () => {
    const item = store.createWorkItem({ title: "audited", createdBy: "session:agent-2" });
    await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, operatorHeaders);
    await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, operatorHeaders);
    const changes = store.listWorkItemEvents(item.id).filter((e) => e.kind === "kept_changed");
    expect(changes.length).toBe(1);
    expect(changes[0].actor).toBe("operator");
    expect(changes[0].detail).toEqual({ kept: true });
  });

  // Criterion 10. With the `caller.kind !== "operator"` check removed from
  // work-item-kept-api.ts this goes green on the 200 and red here.
  it("refuses a non-operator session with 403 and leaves the kept state alone", async () => {
    const item = store.createWorkItem({ title: "not yours to pin", createdBy: "session:agent-3" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "kept-stranger", employee: "platform-worker" });

    const denied = await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, toolHeaders(session.id));
    expect(denied.status).toBe(403);
    expect(keptOf(item.id)).toBe(false);
  });

  it("refuses an employee session even for a Todo it created itself", async () => {
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "kept-creator", employee: "platform-worker" });
    const item = store.createWorkItem({ title: "mine, but not my board", createdBy: `session:${session.id}` });

    const denied = await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, toolHeaders(session.id));
    expect(denied.status).toBe(403);
    expect(keptOf(item.id)).toBe(false);
  });

  it("refuses an unidentified tool call with 403", async () => {
    const item = store.createWorkItem({ title: "anonymous", createdBy: "session:agent-4" });
    const anonymous = await call("PUT", `/api/work-items/${item.id}/kept`, { kept: true }, { [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE });
    expect(anonymous.status).toBe(403);
    expect(keptOf(item.id)).toBe(false);
  });

  it("400s a malformed Todo ID and 404s an unknown one", async () => {
    expect((await call("PUT", "/api/work-items/not-an-id/kept", { kept: true }, operatorHeaders)).status).toBe(400);
    expect((await call("PUT", "/api/work-items/JIN-999999/kept", { kept: true }, operatorHeaders)).status).toBe(404);
  });

  it("400s a body whose `kept` is not a boolean", async () => {
    const item = store.createWorkItem({ title: "bad body", createdBy: "session:agent-5" });
    for (const body of [{}, { kept: "true" }, { kept: 1 }, { kept: null }]) {
      const bad = await call("PUT", `/api/work-items/${item.id}/kept`, body, operatorHeaders);
      expect(bad.status).toBe(400);
    }
    expect(keptOf(item.id)).toBe(false);
  });

  it("falls through on another method, so the path is not swallowed", async () => {
    const item = store.createWorkItem({ title: "wrong verb", createdBy: "operator" });
    expect((await call("GET", `/api/work-items/${item.id}/kept`, undefined, operatorHeaders)).status).toBe(404);
  });
});

describe("the list route reads `kept`", () => {
  const pageIds = async (query: string): Promise<string[]> => {
    const page = await call("GET", `/api/work-items?${query}&limit=200`, undefined, operatorHeaders);
    return page.body.workItems.map((w: { id: string }) => w.id);
  };

  it("puts a Todo on Home when the operator pins it, and takes it off again", async () => {
    const theirs = store.createWorkItem({ title: "an agent's", createdBy: "session:agent-6" });
    const mine = store.createWorkItem({ title: "the operator's", createdBy: "operator" });

    // Nothing reaches Home by being created, the operator's own least
    // of all — `created_by = 'operator'` is every caller holding their token.
    const before = await pageIds("kept=true&rootsOnly=true");
    expect(before).not.toContain(mine.id);
    expect(before).not.toContain(theirs.id);

    await call("PUT", `/api/work-items/${theirs.id}/kept`, { kept: true }, operatorHeaders);
    const after = await call("GET", "/api/work-items?kept=true&rootsOnly=true&limit=200", undefined, operatorHeaders);
    expect(after.body.workItems.map((w: { id: string }) => w.id)).toContain(theirs.id);
    expect(after.body.workItems.find((w: { id: string }) => w.id === theirs.id).kept).toBe(true);

    await call("PUT", `/api/work-items/${theirs.id}/kept`, { kept: false }, operatorHeaders);
    expect(await pageIds("kept=true&rootsOnly=true")).not.toContain(theirs.id);
  });

  /* The regression the operator reported: Home showed the same stuff as
   * Everything. With mixed data the two pages differ by construction. */
  it("returns a strict subset of the same page unfiltered", async () => {
    const pinned = store.createWorkItem({ title: "pinned", createdBy: "session:agent-8" });
    store.createWorkItem({ title: "left alone", createdBy: "session:agent-8" });
    store.createWorkItem({ title: "left alone too", createdBy: "operator" });
    await call("PUT", `/api/work-items/${pinned.id}/kept`, { kept: true }, operatorHeaders);

    const home = await pageIds("kept=true&rootsOnly=true");
    const everything = await pageIds("rootsOnly=true");
    expect(home).toContain(pinned.id);
    expect(home.every((id) => everything.includes(id))).toBe(true);
    expect(home.length).toBeLessThan(everything.length);
  });

  it("leaves the page unscoped when `kept` is absent or anything but true", async () => {
    const theirs = store.createWorkItem({ title: "unkept and listed", createdBy: "session:agent-7" });
    for (const query of ["", "&kept=false", "&kept=yes"]) {
      const page = await call("GET", `/api/work-items?rootsOnly=true&limit=100${query}`, undefined, operatorHeaders);
      expect(page.body.workItems.map((w: { id: string }) => w.id)).toContain(theirs.id);
    }
  });
});
