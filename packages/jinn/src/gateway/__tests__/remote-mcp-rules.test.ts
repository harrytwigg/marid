import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * SC-007: the gateway itself holds the remote MCP connector to its
 * profile and to FR-011, driven through the REAL handleApiRequest as a connector
 * anchor session — not through the tool filter, which these rules exist to back
 * up. The connector amendment lifted FR-013a: the connector is the operator's own door, so its
 * ledger writes reach any Todo or Note the operator's would.
 */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-remote-mcp-rules-"));
process.env.JINN_HOME = tmpHome;
fs.writeFileSync(path.join(tmpHome, "config.yaml"), yaml.dump({
  gateway: { notesEnabled: true },
  engines: { default: "codex", claude: {}, codex: { bin: "codex", model: "gpt-5.5" } },
  portal: { portalName: "Portal COO", setupComplete: true },
  connectors: {}, mcp: {}, sessions: {},
}));
fs.mkdirSync(path.join(tmpHome, "knowledge"), { recursive: true });
fs.writeFileSync(path.join(tmpHome, "knowledge", "state.md"), "# State\n");

type Session = import("../../shared/types.js").Session;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let approvalAuthority: typeof import("../approval-authority.js");
let dispatchConfig: typeof import("../../work-items/dispatch-config.js");
let labels: typeof import("../../work-items/labels.js");
let preflight: typeof import("../../sessions/turn/preflight.js");
let connector: Session;
let operatorTodo: string;

const apiCtx = {
  getConfig: () => yaml.load(fs.readFileSync(path.join(tmpHome, "config.yaml"), "utf-8")),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map([["codex", {}]]),
    getEngine: () => undefined,
    getQueue: () => ({ getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
  },
} as unknown as import("../api.js").ApiContext;

function connectorHeaders(): Record<string, string> {
  return {
    authorization: "Bearer test-token",
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: connector.id,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(connector.id),
  };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = connectorHeaders()) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url, headers: { host: "localhost", "content-type": "application/json", ...headers }, socket: { remoteAddress: "127.0.0.1" },
  });
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as never, res, apiCtx);
  const text = Buffer.concat(chunks).toString("utf-8");
  return { status, body: text ? JSON.parse(text) : undefined };
}

const operator = { authorization: "Bearer test-token" };

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  approvalAuthority = await import("../approval-authority.js");
  dispatchConfig = await import("../../work-items/dispatch-config.js");
  labels = await import("../../work-items/labels.js");
  preflight = await import("../../sessions/turn/preflight.js");
  connector = registry.createSession({ engine: "codex", source: "remote-mcp", sourceRef: "remote-mcp:op@example.com" });
  const created = await call("POST", "/api/work-items", { title: "Operator's own Todo" }, operator);
  operatorTodo = created.body.workItem.id;
});

describe("the connector anchor is not the COO portal (D2, SC-007)", () => {
  it("is not portal-shaped, although an identical web session is", () => {
    expect(registry.isPortalAgentSession(connector)).toBe(false);
    expect(registry.isPortalAgentSession({ ...connector, source: "web" })).toBe(true);
  });

  it("cannot decide a COO-decidable or an operator-only approval", () => {
    const item = { id: operatorTodo } as never;
    for (const opts of [{ cooDecidable: true }, { operatorOnly: true }]) {
      expect(approvalAuthority.resolveApprovalDecisionAuthority(connectorHeaders(), item, opts).ok).toBe(false);
    }
  });

  it("never runs an engine turn (D3)", () => {
    const result = preflight.preflightTurn({ session: connector, engines: new Map(), config: {} } as never);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("remote MCP connector");
  });
});

describe("the gateway admits only the connector's profile routes (D4)", () => {
  it.each([
    ["POST", () => `/api/work-items/${operatorTodo}/status`, { status: "executing" }],
    ["POST", () => "/api/sessions", { prompt: "hi" }],
    ["POST", () => `/api/sessions/${connector.id}/stop`, {}],
    ["GET", () => "/api/knowledge/read?path=config.yaml", undefined],
    ["POST", () => `/api/work-items/${operatorTodo}/attachments`, { path: "/etc/hostname" }],
    ["GET", () => "/api/experiments", undefined],
    ["GET", () => "/api/workflows", undefined],
  ])("refuses %s %s", async (method, url, body) => {
    const r = await call(method, url(), body);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("outside the remote MCP connector's tool profile");
  });

  it("admits a profile read", async () => {
    expect((await call("GET", "/api/work-items")).status).toBe(200);
  });
});

describe("connector writes stand where the operator's do (FR-013a lifted)", () => {
  let own: string;
  const version = async (id: string) => (await call("GET", `/api/work-items/${id}`, undefined, operator)).body.workItem.version;

  it("creates Todos as startable as the operator's, unless it opts out", async () => {
    const r = await call("POST", "/api/work-items", { title: "From claude.ai" });
    expect(r.status).toBe(201);
    own = r.body.workItem.id;
    expect(dispatchConfig.getTodoDispatchConfig(own)?.autoStart ?? true).toBe(true);
    expect(labels.getWorkItemLabels(own).map((label) => label.name)).not.toContain("no-auto-start");
    const optedOut = (await call("POST", "/api/work-items", { title: "Hold this", autoStart: false })).body.workItem.id;
    expect(dispatchConfig.getTodoDispatchConfig(optedOut)?.autoStart).toBe(false);
  });

  it("edits, labels and relates the operator's Todos, not only its own", async () => {
    const edited = await call("PATCH", `/api/work-items/${operatorTodo}`, { title: "Renamed by voice", expectedVersion: await version(operatorTodo) });
    expect(edited.status).toBe(200);
    expect((await call("GET", `/api/work-items/${operatorTodo}`, undefined, operator)).body.workItem.title).toBe("Renamed by voice");
    labels.createLabel({ name: "voice" });
    expect((await call("PUT", `/api/work-items/${operatorTodo}/labels`, { add: ["voice"] })).status).toBe(200);
    expect((await call("POST", `/api/work-items/${operatorTodo}/relations`, { kind: "blocks", dstId: own })).status).toBe(201);
    expect((await call("POST", "/api/work-items", { title: "Child of the operator's", parentId: operatorTodo })).status).toBe(201);
  });

  it("removes no-auto-start like the operator can", async () => {
    labels.createLabel({ name: "no-auto-start" });
    const held = (await call("POST", "/api/work-items", { title: "Held", labels: ["no-auto-start"] }, operator)).body.workItem.id;
    expect((await call("PUT", `/api/work-items/${held}/labels`, { remove: ["no-auto-start"] })).status).toBe(200);
    expect(labels.getWorkItemLabels(held).map((label) => label.name)).not.toContain("no-auto-start");
  });

  it("unlinks a relation the operator made", async () => {
    const other = (await call("POST", "/api/work-items", { title: "Other" }, operator)).body.workItem.id;
    expect((await call("POST", `/api/work-items/${operatorTodo}/relations`, { kind: "relates", dstId: other }, operator)).status).toBe(201);
    expect((await call("DELETE", `/api/work-items/${operatorTodo}/relations`, { kind: "relates", dstId: other })).status).toBe(200);
  });

  it("writes and updates Notes anywhere the operator could", async () => {
    const loose = await call("POST", "/api/notes", { title: "Loose" });
    expect(loose.status).toBe(201);
    const operatorNote = await call("POST", "/api/notes", { title: "Operator runbook", folder: "runbooks" }, operator);
    const updated = await call("PUT", "/api/notes", { path: operatorNote.body.note.path, expectedRevision: operatorNote.body.note.revision, body: "rewritten by voice" });
    expect(updated.status).toBe(200);
  });

  it("still records a comment, and still has no attachment route", async () => {
    expect((await call("POST", `/api/work-items/${own}/comments`, { body: "from claude.ai" })).status).toBe(201);
    expect((await call("POST", `/api/work-items/${own}/attachments`, { path: "/etc/hostname" })).status).toBe(403);
  });
});
