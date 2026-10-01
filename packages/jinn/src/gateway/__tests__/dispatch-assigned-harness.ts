import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

/**
 * The fixture the dispatch-on-an-owned-Todo route tests share: a throwaway
 * JINN_HOME with two ordinary employees (so a Todo can be owned by one and
 * re-routed to the other), an engine whose every run hangs so an attempt stays
 * in flight, and a `call` that drives `handleApiRequest` directly.
 *
 * JINN_HOME is set as this module is evaluated, so a test file must import it
 * BEFORE anything that reads the home; the gateway modules are imported
 * dynamically from `startDispatchHarness` for that reason.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dispatch-assigned-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
for (const [name, displayName] of [["first-worker", "First Worker"], ["second-worker", "Second Worker"]]) {
  fs.writeFileSync(
    path.join(home, "org", `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${displayName}`,
      "department: platform",
      "rank: employee",
      "engine: codex",
      "model: gpt-5.6-sol",
      "persona: Completes bounded route work",
      "",
    ].join("\n"),
  );
}

type Api = typeof import("../api.js");
export type Registry = typeof import("../../sessions/registry.js");
export type WorkItems = typeof import("../../work-items/store.js");

let api: Api;
export let registry: Registry;
export let workItems: WorkItems;

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
    gateway: { port: 7796, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }] },
      codex: {
        default: "gpt-5.6-sol",
        models: [{ id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
      },
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
    getEngine: () => engineStub,
    getEngines: () => new Map(),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) { status = nextStatus; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json", ...headers },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(request as unknown as Parameters<Api["handleApiRequest"]>[0], captured.res, context);
  return { status: captured.status, body: captured.body };
}

export async function startDispatchHarness(): Promise<void> {
  const dbModule = await import("../../shared/db.js");
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
}

export async function stopDispatchHarness(): Promise<void> {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
}

/** A backlog Todo with an assignee: the shape "assigned" collapsed into. */
export function assignedTodo(title: string, assignee = "first-worker") {
  return workItems.createWorkItem({ title, source: "human", status: "backlog", assignee, department: "platform" });
}

/** The operator presses Dispatch. */
export function dispatch(workItemId: string) {
  return call("POST", `/api/work-items/${workItemId}/dispatch`, {});
}

/** `delegate_task` onto an existing Todo, as the given session. */
export function delegate(callerSessionId: string, workItemId: string, employee: string) {
  return call(
    "POST",
    "/api/delegations",
    { workItemId, employee, task: "Complete the Todo acceptance criteria and report evidence." },
    {
      [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
      [CALLER_SESSION_HEADER]: callerSessionId,
      [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(callerSessionId),
    },
  );
}

/** A plain session of `employee`, not linked to anything. */
export function employeeSession(employee: string, sourceRef: string) {
  return registry.createSession({ engine: "codex", source: "web", sourceRef, connector: "web", employee, prompt: "work it" });
}

/** A session of `employee` linked to the Todo as an execution attempt, in the given state. */
export function linkedAttempt(workItemId: string, employee: string, status: "running" | "idle" | "error", sourceRef: string) {
  const session = employeeSession(employee, sourceRef);
  workItems.linkSession(workItemId, session.id);
  registry.updateSession(session.id, { status });
  return session;
}

export function sessionsOf(workItemId: string, employee: string) {
  return registry.listSessionsByWorkItem(workItemId).filter((session) => session.employee === employee);
}
