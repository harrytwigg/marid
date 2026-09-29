import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-claim-routes-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "claim-worker.yaml"),
  [
    "name: claim-worker",
    "displayName: Claim Worker",
    "department: platform",
    "rank: employee",
    "engine: codex",
    "model: gpt-5.6-sol",
    "persona: Completes bounded route work",
    "",
  ].join("\n"),
);

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
type Runs = typeof import("../../work-items/runs.js");

let api: Api;
let registry: Registry;
let workItems: WorkItems;
let claims: Claims;
let runs: Runs;

let engineAvailable = true;

const engineStub = {
  name: "stub",
  run: async () => new Promise(() => {}),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => fn(),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

function config(): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" } },
    models: {
      codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["high"] }] },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    mcp: { gateway: { enabled: true } },
  } as unknown as JinnConfig;
}

const context = {
  getConfig: config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => (engineAvailable ? engineStub : undefined),
    getEngines: () => new Map(),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

async function call(method: string, url: string, body?: unknown) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" },
  });
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(request as unknown as Parameters<Api["handleApiRequest"]>[0], res, context);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return { status, body: raw ? JSON.parse(raw) as Record<string, unknown> : undefined };
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
  runs = await import("../../work-items/runs.js");
  await import("../../shared/db.js").then((db) => db.initDb());
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterEach(() => { engineAvailable = true; });

/** A live attempt on `workItemId`, holding its claim the way a real worker does. */
function liveWorker(workItemId: string, owner: string): string {
  const session = registry.createSession({
    engine: "codex", source: "web", sourceRef: `worker-${owner}-${workItemId}`, connector: "web", prompt: "work",
  });
  registry.updateSession(session.id, { status: "running" });
  claims.claimWorkItem({ workItemId, owner, sessionId: session.id });
  return session.id;
}

describe("POST /api/delegations onto a claimed Todo", () => {
  it("refuses the delegation and spawns nothing", async () => {
    const item = workItems.createWorkItem({ title: "already being worked", source: "human" });
    const worker = liveWorker(item.id, "someone-else");
    const before = registry.countSessions();

    const response = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "claim-worker", task: "Work it again",
    });

    expect(response.status).toBe(409);
    expect(String(response.body?.error)).toContain(worker);
    expect(registry.countSessions()).toBe(before);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("someone-else");
  });

  it("claims, links, and opens a run on the way through", async () => {
    const item = workItems.createWorkItem({ title: "free to delegate", source: "human" });

    const response = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "claim-worker", task: "Work it",
    });

    expect(response.status).toBe(201);
    const sessionId = String(response.body?.sessionId);
    expect(claims.getWorkItemClaim(item.id)?.sessionId).toBe(sessionId);
    expect(registry.getSession(sessionId)?.workItemId).toBe(item.id);
    expect(runs.findOpenWorkItemRunBySession(sessionId)?.workItemId).toBe(item.id);
  });

  it("claims the Todo it minted, so a second delegation onto it is refused", async () => {
    const minted = await call("POST", "/api/delegations", { employee: "claim-worker", task: "Fresh work" });

    expect(minted.status).toBe(201);
    const workItemId = String(minted.body?.workItemId);
    expect(claims.getWorkItemClaim(workItemId)?.sessionId).toBe(String(minted.body?.sessionId));

    const second = await call("POST", "/api/delegations", {
      workItemId, employee: "claim-worker", task: "Work it again",
    });

    expect(second.status).toBe(409);
    expect(String(second.body?.error)).toContain(String(minted.body?.sessionId));
  });

  it("files a delegation-minted Todo under the configured default, not the delegate's org department (JIN-1)", async () => {
    const config = path.join(home, "config.yaml");
    fs.writeFileSync(
      config,
      "engines:\n  default: claude\n  claude: {}\ngateway:\n  port: 7777\n  host: 127.0.0.1\n  todoDepartments:\n    allowed: [labs, jinn, general]\n    default: general\n",
      "utf8",
    );
    try {
      const minted = await call("POST", "/api/delegations", { employee: "claim-worker", task: "Classified work" });
      expect(minted.status).toBe(201);
      expect(workItems.getWorkItem(String(minted.body?.workItemId))?.department).toBe("general");
    } finally {
      fs.rmSync(config, { force: true });
    }
  });

  it("hands the Todo back when the spawn cannot happen", async () => {
    const item = workItems.createWorkItem({ title: "engine is gone", source: "human" });
    engineAvailable = false;

    const response = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "claim-worker", task: "Work it",
    });

    expect(response.status).toBe(502);
    expect(claims.getWorkItemClaim(item.id)).toBeUndefined();
  });
});

describe("POST /api/work-items/:id/dispatch onto a claimed Todo", () => {
  it("refuses a second worker rather than dispatching on top of one", async () => {
    const item = workItems.createWorkItem({ title: "worked by a delegate", source: "human" });
    const worker = liveWorker(item.id, "someone-else");
    const before = registry.countSessions();

    const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

    expect(response.status).toBe(409);
    expect(String(response.body?.error)).toContain(worker);
    expect(registry.countSessions()).toBe(before);
  });

  it("claims and binds its Dispatcher session on the way through", async () => {
    const item = workItems.createWorkItem({ title: "free to dispatch", source: "human" });

    const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

    expect(response.status).toBe(201);
    expect(claims.getWorkItemClaim(item.id)?.sessionId).toBe(String(response.body?.sessionId));
  });
});
