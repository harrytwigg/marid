import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * What the COO lane may and may not do to a Todo it does not own.
 *
 * The COO is not an org employee, so `authorizeWorkItemOwnerManagerOrRoot()`
 * used to refuse it for having no employee name to check — the shape that makes
 * it the operator's own lane read as no identity at all. It is admitted now for
 * the lifecycle routes it is meant to reach (delegation, below).
 *
 * Archiving is not among them: it is the operator's or the connector's alone, so
 * the portal session is refused like every other session.
 *
 * The last half is the boundary. Widening the lifecycle lane must not reach
 * the decision that was routed away from agents on purpose: closing work you
 * produced yourself.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-coo-lane-authority-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: gpt-5.5\npersona: Generic route-test worker.\n",
);

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
let api: Api;
let reg: Reg;
let store: Store;

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

// Enough engine for the delegation route to reach its spawn: the turn itself is
// never run, because what is under test happens before one.
const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const ctx = {
  getConfig: () => ({
    gateway: {},
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.5" } },
    models: { codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5" }] } },
    sessions: {},
  }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => ({
      enqueue: async () => undefined,
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function toolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function post(urlPath: string, body: Record<string, unknown>, headers: Record<string, string>) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
  const cap = makeRes();
  await api.handleApiRequest(req, cap.res, ctx);
  return cap;
}

/** The gateway's own top-level agent session: the COO the operator talks to. */
function portalSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref }).id;
}

const processFetch = globalThis.fetch;

beforeAll(async () => {
  // The delegation route fires manager-visibility notices at the gateway over
  // HTTP. Keep the suite in-process: no notice may reach an installed one.
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

afterAll(() => {
  globalThis.fetch = processFetch;
});

describe("POST /api/work-items/:id/archive — the COO lane's standing", () => {
  it("refuses it: archiving is the operator's, so the portal session cannot archive either", async () => {
    const item = store.createWorkItem({
      title: "Superseded objective",
      status: "backlog",
      assignee: "platform-worker",
      source: "human",
    });
    const coo = portalSession("web:coo-archives");

    const cap = await post(`/api/work-items/${item.id}/archive`, { note: "Replaced by a newer objective." }, toolHeaders(coo));

    expect([cap.status, cap.body.error]).toEqual([
      403,
      `archiving Todo ${item.id} is the operator's decision; agents do not archive Todos`,
    ]);
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
  });
});

describe("POST /api/delegations — the COO lane's standing", () => {
  it("names the session even when the delegation moves no assignment", async () => {
    // Assignee and department already match, so assignWorkItem no-ops and the
    // link is the only thing that happened — which is exactly when the audit
    // used to lose the caller.
    const item = store.createWorkItem({
      title: "Objective owned elsewhere",
      status: "backlog",
      assignee: "platform-worker",
      department: "platform",
      source: "human",
    });
    const coo = portalSession("web:coo-delegates");

    const cap = await post(
      "/api/delegations",
      { workItemId: item.id, employee: "platform-worker", task: "Pick up the objective" },
      toolHeaders(coo),
    );

    // 201 Created is this route's success code: it creates a session.
    expect([cap.status, cap.body.workItemId]).toEqual([201, item.id]);
    expect(store.listWorkItemEvents(item.id)).toContainEqual(
      expect.objectContaining({ kind: "session_linked", actor: `session:${coo}` }),
    );
  });
});

describe("the decision the COO lane still does not reach", () => {
  it("refuses it its own produced work, claim or no claim", async () => {
    const item = store.createWorkItem({ title: "The COO's own work", status: "in_review" });
    const coo = portalSession("web:coo-self-closes");
    store.linkSession(item.id, coo);

    const cap = await post(
      `/api/work-items/${item.id}/status`,
      { status: "done", asOperator: true, note: "Closing my own work." },
      toolHeaders(coo),
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toMatch(/self-review ban/);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
  });
});
