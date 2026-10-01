import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Dispatch on a Todo somebody already owns.
 *
 * The Dispatcher routes for the operator who pressed the button. On an
 * unassigned Todo its own link made it the owner, so delegation passed the
 * owner rule by accident; on an assigned one the owner is the assignee, and
 * the Dispatcher's one job ended in a 403 inside its session. These tests pin
 * the sanctioned path (a Dispatcher may delegate the Todo it was started for,
 * and nothing else), the guard it must not weaken, and what Dispatch does when
 * the Todo is already being executed.
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

const dbModule = await import("../../shared/db.js");

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");

let api: Api;
let registry: Registry;
let workItems: WorkItems;

// Every started session hangs, so an attempt stays in flight and inspectable.
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

function asSession(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function assignedTodo(title: string, assignee = "first-worker") {
  return workItems.createWorkItem({ title, source: "human", status: "assigned", assignee, department: "platform" });
}

/** The operator presses Dispatch. */
async function dispatch(workItemId: string) {
  return call("POST", `/api/work-items/${workItemId}/dispatch`, {});
}

function delegate(callerSessionId: string, workItemId: string, employee: string) {
  return call(
    "POST",
    "/api/delegations",
    { workItemId, employee, task: "Complete the Todo acceptance criteria and report evidence." },
    asSession(callerSessionId),
  );
}

/** A session of `employee` linked to the Todo as an execution attempt, in the given state. */
function linkedAttempt(workItemId: string, employee: string, status: "running" | "idle" | "error", sourceRef: string) {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef, connector: "web", employee, prompt: "work it" });
  workItems.linkSession(workItemId, session.id);
  registry.updateSession(session.id, { status });
  return session;
}

function sessionsOf(workItemId: string, employee: string) {
  return registry.listSessionsByWorkItem(workItemId).filter((session) => session.employee === employee);
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

describe("Dispatch on an assigned Todo", () => {
  // The regression: this delegation used to be refused with "does not own
  // Todo ... and is not its authorized manager/root".
  it("lets the Dispatcher re-route an assigned Todo to the employee it picked", async () => {
    const item = assignedTodo("Assigned by the operator, re-routed by Dispatch");

    const dispatched = await dispatch(item.id);
    expect(dispatched.status).toBe(201);
    const dispatcherId = dispatched.body.sessionId as string;
    expect(registry.getSession(dispatcherId)?.employee).toBe("todo-dispatcher");

    const delegated = await delegate(dispatcherId, item.id, "second-worker");

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({
      employee: "second-worker",
      parentSessionId: dispatcherId,
      workItemId: item.id,
      workItemRole: "execute",
    });
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "second-worker", status: "executing" });
  });

  it("lets the Dispatcher start the existing assignee, tracked on the same Todo", async () => {
    const item = assignedTodo("Assigned by the operator, started by Dispatch");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, item.id, "first-worker");

    expect(delegated.status).toBe(201);
    expect(delegated.body.workItemId).toBe(item.id);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ employee: "first-worker", workItemId: item.id });
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
  });

  it("puts the status and current assignee in the Dispatcher's brief", async () => {
    const item = assignedTodo("Brief names the assignee");

    const dispatched = await dispatch(item.id);

    const prompt = registry.getMessages(dispatched.body.sessionId).find((message) => message.role === "user")?.content;
    expect(prompt).toContain("Status: assigned");
    expect(prompt).toContain("Assignee: first-worker");
  });
});

describe("delegate_task ownership guard", () => {
  it("still refuses an employee that is not the Todo's owner, manager or root", async () => {
    const item = assignedTodo("Owned by the first worker");
    const outsider = registry.createSession({
      engine: "codex", source: "web", sourceRef: "outsider:1", connector: "web", employee: "second-worker", prompt: "unrelated",
    });

    const delegated = await delegate(outsider.id, item.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/employee "second-worker" does not own Todo .* cannot delegate/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker", status: "assigned" });
  });

  it("binds a Dispatcher to the Todo it was started for and no other", async () => {
    const dispatchedFor = assignedTodo("The Todo the Dispatcher was started for");
    const other = assignedTodo("Somebody else's Todo");
    const dispatcherId = (await dispatch(dispatchedFor.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, other.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/employee "todo-dispatcher" does not own Todo/);
    expect(workItems.getWorkItem(other.id)).toMatchObject({ assignee: "first-worker" });
  });

  // The standing comes from the gateway having started the session, not from
  // the employee name: a session that merely calls itself the Dispatcher and is
  // linked to the Todo gets the ordinary rule.
  it("refuses a todo-dispatcher session the gateway did not start on that Todo", async () => {
    const item = assignedTodo("Claimed by an impostor");
    const impostor = registry.createSession({
      engine: "codex", source: "web", sourceRef: "impostor:1", connector: "web", employee: "todo-dispatcher", prompt: "route it",
    });
    workItems.linkSession(item.id, impostor.id);
    registry.updateSession(impostor.id, { status: "idle" });

    const delegated = await delegate(impostor.id, item.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/todo-dispatcher/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
  });
});

describe("Dispatch on a Todo that is already executing", () => {
  it("refuses at click time while an execution attempt is in flight, without starting a Dispatcher", async () => {
    const item = assignedTodo("Being worked right now");
    // Linked without a claim, the way cron and talk start work.
    const worker = linkedAttempt(item.id, "first-worker", "running", "worker:live");
    const sessionsBefore = registry.countSessions();

    const response = await dispatch(item.id);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", workItemId: item.id, sessionId: worker.id });
    expect(response.body.error).toMatch(/already being worked by first-worker/);
    expect(registry.countSessions()).toBe(sessionsBefore);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(0);
  });

  it("refuses when the assignee's attempt is idle between turns, pointing at that session", async () => {
    const item = workItems.createWorkItem({
      title: "Producer waiting on review", source: "human", status: "executing", assignee: "first-worker", department: "platform",
    });
    const producer = linkedAttempt(item.id, "first-worker", "idle", "worker:idle");
    const sessionsBefore = registry.countSessions();

    const response = await dispatch(item.id);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", sessionId: producer.id });
    expect(response.body.error).toMatch(/idle between turns/);
    expect(registry.countSessions()).toBe(sessionsBefore);
  });

  // The stranded shape the bug report came from: the only execute link is an
  // earlier Dispatcher's, which routes and never works. Dispatch is the way out.
  it("restarts a Todo whose only linked attempt is an earlier Dispatcher, and the new one can delegate", async () => {
    const item = assignedTodo("Left executing by a Dispatcher that stopped");
    const first = await dispatch(item.id);
    registry.updateSession(first.body.sessionId, { status: "idle" });
    const { releaseWorkItemClaimForSession } = await import("../../work-items/claims.js");
    releaseWorkItemClaimForSession(first.body.sessionId);
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");

    const again = await dispatch(item.id);

    expect(again.status).toBe(201);
    expect(again.body.sessionId).not.toBe(first.body.sessionId);
    expect((await delegate(again.body.sessionId, item.id, "first-worker")).status).toBe(201);
  });

  it("lets Dispatch start a reassigned Todo whose idle attempt belongs to the previous assignee", async () => {
    const item = workItems.createWorkItem({
      title: "Handed to someone new", source: "human", status: "executing", assignee: "second-worker", department: "platform",
    });
    linkedAttempt(item.id, "first-worker", "idle", "worker:previous");

    const response = await dispatch(item.id);

    expect(response.status).toBe(201);
    expect(registry.getSession(response.body.sessionId)?.employee).toBe("todo-dispatcher");
  });

  // The Dispatcher's own execute link must not let it, or a second Dispatcher,
  // run beside the employee it handed the Todo to.
  it("after the hand-off, refuses a second Dispatch while the delegate works instead of reusing the Dispatcher", async () => {
    const item = assignedTodo("Handed off and in progress");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const delegated = await delegate(dispatcherId, item.id, "first-worker");
    expect(delegated.status).toBe(201);

    const again = await dispatch(item.id);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", sessionId: delegated.body.sessionId });
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
    expect(sessionsOf(item.id, "first-worker")).toHaveLength(1);

    // And the Dispatcher cannot hand it on a second time beside the live delegate.
    const twice = await delegate(dispatcherId, item.id, "second-worker");
    expect(twice.status).toBe(409);
    expect(sessionsOf(item.id, "second-worker")).toHaveLength(0);
  });
});
