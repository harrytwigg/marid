import { describe, it, expect, beforeAll } from "vitest";
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
 * `asOperator` on POST /api/work-items/:id/status: the coordinator closing a
 * Todo as done on the operator's behalf, with a reason. What the claim buys is
 * pinned in work-items-route-status-lanes.test.ts; this file pins who can never
 * make it.
 *
 * The COO is not an org employee, so the claim is decided by session SHAPE —
 * top-level, employee-less, no workflow provenance — and not by any employee
 * name. The fixture keeps an executive precisely to prove that rank buys
 * nothing here.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-as-operator-"));
process.env.JINN_HOME = tmp;
fs.mkdirSync(path.join(tmp, "org"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "org", "company-coo.yaml"),
  "name: company-coo\ndisplayName: Company COO\ndepartment: company\nrank: executive\nengine: codex\nmodel: default\npersona: Generic route-test COO.\n",
);
fs.writeFileSync(
  path.join(tmp, "org", "platform-worker.yaml"),
  "name: platform-worker\ndisplayName: Platform Worker\ndepartment: platform\nrank: employee\nengine: codex\nmodel: default\npersona: Generic route-test worker.\n",
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

function makeReq(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  return Object.assign(Readable.from(payload), {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
  }) as unknown as Parameters<Api["handleApiRequest"]>[0];
}

const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => undefined,
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

async function setStatus(id: string, body: Record<string, unknown>, headers: Record<string, string>, method = "POST") {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, `/api/work-items/${id}/status`, body, headers), cap.res, ctx);
  return cap;
}

function session(employee: string, ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref, employee }).id;
}

/** The gateway's own top-level agent session: the COO the operator talks to. */
function portalSession(ref: string): string {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: ref }).id;
}

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  (await import("../../shared/db.js")).initDb();
});

describe("POST /api/work-items/:id/status — asOperator", () => {
  it("refuses every employee's claim, executive rank included — the COO is not an employee", async () => {
    for (const [employee, ref] of [["platform-worker", "web:worker-claims"], ["company-coo", "web:executive-claims"]] as const) {
      const item = store.createWorkItem({ title: `Not ${employee}'s to close`, status: "executing" });
      const cap = await setStatus(item.id, { status: "done", asOperator: true, note: "closing it" }, toolHeaders(session(employee, ref)));

      expect(cap.status).toBe(403);
      expect(cap.body.error).toMatch(/asOperator is reserved for the operator's coordinator session/);
      expect(cap.body.error).toMatch(new RegExp(`employee "${employee}" moves Todo`));
      expect(store.getWorkItem(item.id)?.status).toBe("executing");
    }
  });

  it("refuses a session an employee could produce: a child, and a legacy workflow attempt", async () => {
    const parent = portalSession("web:coo-parent");
    const child = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:coo-child", parentSessionId: parent }).id;
    const attempt = reg.createSession({ engine: "codex", source: "workflow", sourceRef: "wf:attempt" }).id;

    for (const caller of [child, attempt]) {
      const item = store.createWorkItem({ title: "Derived session", status: "executing" });
      const cap = await setStatus(item.id, { status: "done", asOperator: true, note: "closing it" }, toolHeaders(caller));
      expect(cap.status).toBe(403);
      expect(cap.body.error).toMatch(/coordinator session/);
      expect(store.getWorkItem(item.id)?.status).toBe("executing");
    }
  });

  it("leaves the operator surface itself unchanged, claimed or not", async () => {
    const item = store.createWorkItem({ title: "Operator move", status: "backlog" });

    const plain = await setStatus(item.id, { status: "executing" }, operatorHeaders);
    expect([plain.status, plain.body.workItem.status]).toEqual([200, "executing"]);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({ actor: "operator" });
    expect(store.listWorkItemEvents(item.id).at(-1)?.detail).not.toHaveProperty("asOperator");

    const claimed = await setStatus(item.id, { status: "in_review", asOperator: true }, operatorHeaders);
    expect([claimed.status, claimed.body.workItem.status]).toEqual([200, "in_review"]);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({ actor: "operator" });
    expect(store.listWorkItemEvents(item.id).at(-1)?.detail).not.toHaveProperty("asOperator");
  });

  it("rejects a non-boolean claim rather than reading it as off", async () => {
    const item = store.createWorkItem({ title: "Stringly typed", status: "executing" });
    const coo = portalSession("web:coo-badtype");

    const cap = await setStatus(item.id, { status: "done", asOperator: "true", note: "closing it" }, toolHeaders(coo));

    expect([cap.status, cap.body.error]).toEqual([400, "asOperator must be a boolean"]);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
  });

  it("keeps the cascade on the operator's own surface: the coordinator's claim does not reach it", async () => {
    const item = store.createWorkItem({ title: "Parent of open work", status: "in_review" });
    const coo = portalSession("web:coo-cascades");

    const cap = await setStatus(item.id, { status: "done", asOperator: true, cascade: true, note: "closing it" }, toolHeaders(coo));

    expect([cap.status, cap.body.error]).toEqual([
      403,
      "closing a Todo's open descendants with it is an operator-surface decision",
    ]);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
  });
});
