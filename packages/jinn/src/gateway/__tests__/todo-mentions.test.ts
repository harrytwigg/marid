import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// Mentions, replies and delegations onto a Todo all go through one session per
// (Todo, employee). Driven through the real routes, registry and Todo store on a
// throwaway home; the outbox's HTTP hop is stubbed, so a delivery is the row it
// claims and nothing leaves the process.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-mentions-"));
process.env.JINN_HOME = home;

const delivered = vi.hoisted(() => [] as string[]);
vi.mock("../../sessions/callbacks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/callbacks.js")>();
  return {
    ...actual,
    deliverClaimedSessionDelivery: async (id: string) => {
      delivered.push(id);
      return "accepted" as const;
    },
  };
});

fs.mkdirSync(path.join(home, "org"), { recursive: true });
for (const [name, rank, reportsTo] of [["org-root", "executive", ""], ["alpha", "employee", "org-root"], ["bravo", "employee", "org-root"], ["worker", "employee", "org-root"]]) {
  fs.writeFileSync(path.join(home, "org", `${name}.yaml`), [
    `name: ${name}`, `displayName: ${name[0].toUpperCase()}${name.slice(1)}`, "department: platform", `rank: ${rank}`,
    ...(reportsTo ? [`reportsTo: ${reportsTo}`] : []), "engine: codex", "model: gpt-5.5", `persona: ${name} for mention tests`, "",
  ].join("\n"));
}

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Store = typeof import("../../work-items/store.js");
type Records = typeof import("../../work-items/employee-sessions.js");
let api: Api;
let registry: Registry;
let store: Store;
let records: Records;
let claims: typeof import("../../work-items/claims.js");
let callbacks: typeof import("../../sessions/callbacks.js");
let db: import("better-sqlite3").Database;

const engineStub = { name: "stub", run: async () => ({ result: "ok" }), isAlive: () => false, kill: () => {}, killAll: () => {} };
const context = {
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
    // Turns are queued, never run: a started session stays `running`.
    getQueue: () => ({
      enqueue: async () => undefined,
      clearCancelled: () => {},
      clearQueue: () => {},
      pauseQueue: () => {},
      resumeQueue: () => {},
      getPendingCount: () => 0,
      getTransportState: (_key: string, status: string) => status,
    }),
  },
} as unknown as import("../api.js").ApiContext;

function sessionHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

async function call(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json", ...(headers[CALLER_SESSION_HEADER] ? {} : { authorization: "Bearer test-token" }), ...headers },
  });
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(next: number) { status = next; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], res, context);
  return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any> };
}

async function comment(todoId: string, body: string, opts: { as?: string; parentCommentId?: string } = {}) {
  const res = await call("POST", `/api/work-items/${todoId}/comments`, { body, ...(opts.parentCommentId ? { parentCommentId: opts.parentCommentId } : {}) },
    opts.as ? sessionHeaders(opts.as) : {});
  expect(res.status).toBe(201);
  return res.body.comment as { id: string; parentCommentId: string | null; repliedToId?: string };
}

const sessionsOf = (todoId: string, employee: string) =>
  registry.listSessionsByWorkItem(todoId).filter((session) => session.employee === employee);

const deliveriesTo = (sessionId: string, kind?: string) =>
  (db.prepare("SELECT delivery_kind FROM callback_deliveries WHERE target_session_id = ?").all(sessionId) as Array<{ delivery_kind: string }>)
    .map((row) => row.delivery_kind)
    .filter((deliveryKind) => !kind || deliveryKind === kind);

/** An execution session of `employee` holding the Todo's claim, like a dispatched one. */
function executing(todoId: string, employee = "worker") {
  const session = registry.createSession({ engine: "codex", source: "web", sourceRef: `exec:${crypto.randomUUID()}`, employee, connector: "web" });
  store.linkSession(todoId, session.id);
  registry.updateSession(session.id, { status: "running" });
  claims.claimWorkItem({ workItemId: todoId, owner: `delegation:${crypto.randomUUID()}`, sessionId: session.id });
  return registry.getSession(session.id)!;
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
  records = await import("../../work-items/employee-sessions.js");
  claims = await import("../../work-items/claims.js");
  callbacks = await import("../../sessions/callbacks.js");
  db = (await import("../../shared/db.js")).initDb();
  (await import("../todo-comment-routing.js")).installTodoCommentRouting(context);
});

beforeEach(() => {
  delivered.length = 0;
});

describe("mentions", () => {
  it("starts one linked consult session per mentioned employee without disturbing the claim holder", async () => {
    const item = store.createWorkItem({ title: "two opinions", assignee: "worker", status: "executing" });
    const holder = executing(item.id);

    await comment(item.id, "@alpha and @bravo, does this look right?");

    for (const employee of ["alpha", "bravo"]) {
      const [session] = sessionsOf(item.id, employee);
      expect(sessionsOf(item.id, employee)).toHaveLength(1);
      expect(session).toMatchObject({ workItemRole: "consult", parentSessionId: null });
      expect(registry.getMessages(session.id)[0].content).toContain(`You were tagged in this comment on Todo ${item.id}`);
      expect(records.getEmployeeSessionRecord(item.id, employee)?.sessionId).toBe(session.id);
    }
    expect(claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
    expect(store.getWorkItem(item.id)).toMatchObject({ status: "executing", assignee: "worker" });
  });

  it("delivers a repeat mention, in a later comment or a reply, into the same session", async () => {
    const item = store.createWorkItem({ title: "keep asking alpha" });
    const first = await comment(item.id, "@alpha first question");
    const [session] = sessionsOf(item.id, "alpha");

    await comment(item.id, "@alpha second question");
    await comment(item.id, "and @Alpha, in the thread", { parentCommentId: first.id });

    expect(sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(deliveriesTo(session.id, "todo-mention")).toHaveLength(2);
  });

  it("delivers into the execution session an employee already holds on the Todo", async () => {
    const item = store.createWorkItem({ title: "ask the worker", assignee: "worker", status: "executing" });
    const holder = executing(item.id);

    await comment(item.id, "@worker how is it going?");

    expect(sessionsOf(item.id, "worker").map((session) => session.id)).toEqual([holder.id]);
    expect(deliveriesTo(holder.id, "todo-mention")).toHaveLength(1);
    expect(registry.getSession(holder.id)?.workItemRole).toBe("execute");
  });

  it.each(["idle", "waiting", "interrupted"] as const)("delivers into the employee's %s session", async (status) => {
    const item = store.createWorkItem({ title: `alpha is ${status}` });
    await comment(item.id, "@alpha are you there?");
    const [session] = sessionsOf(item.id, "alpha");
    registry.updateSession(session.id, { status });

    await comment(item.id, "@alpha still there?");

    expect(sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(deliveriesTo(session.id, "todo-mention")).toHaveLength(1);
  });

  it("starts a fresh session when the recorded one errored or was archived", async () => {
    const item = store.createWorkItem({ title: "alpha's session died" });
    await comment(item.id, "@alpha one");
    const [dead] = sessionsOf(item.id, "alpha");
    registry.updateSession(dead.id, { status: "error" });

    await comment(item.id, "@alpha two");
    const fresh = records.getEmployeeSessionRecord(item.id, "alpha")!.sessionId;
    registry.updateSession(fresh, { archivedAt: new Date().toISOString() });
    await comment(item.id, "@alpha three");

    expect(new Set(sessionsOf(item.id, "alpha").map((session) => session.id)).size).toBe(3);
    expect(records.getEmployeeSessionRecord(item.id, "alpha")!.sessionId).not.toBe(fresh);
  });

  it("starts one session for two near-simultaneous mentions", async () => {
    const item = store.createWorkItem({ title: "two at once" });

    await Promise.all([comment(item.id, "@bravo one"), comment(item.id, "@bravo two")]);

    expect(sessionsOf(item.id, "bravo")).toHaveLength(1);
  });

  it("wakes nobody for a comment without a mention, or for names that cannot be woken", async () => {
    const item = store.createWorkItem({ title: "quiet", assignee: "worker", status: "executing" });
    const holder = executing(item.id);
    const author = registry.createSession({ engine: "codex", source: "web", sourceRef: `alpha:${crypto.randomUUID()}`, employee: "alpha", connector: "web" });

    await comment(item.id, "Just a note for the record.");
    await comment(item.id, "Mail ops@example.com, ask @nobody or @todo-dispatcher, quote `@bravo`.");
    await comment(item.id, "Note to self, @alpha.", { as: author.id });

    expect(registry.listSessionsByWorkItem(item.id).map((session) => session.id)).toEqual([holder.id]);
    expect(deliveriesTo(holder.id)).toEqual([]);
    expect(delivered).toEqual([]);
  });
});

describe("replies", () => {
  it("reaches the session that wrote the comment answered, though it is stored under the operator's root", async () => {
    const item = store.createWorkItem({ title: "threaded" });
    const root = await comment(item.id, "@alpha what do you think?");
    const [alpha] = sessionsOf(item.id, "alpha");
    const answer = await comment(item.id, "I think it's fine.", { as: alpha.id, parentCommentId: root.id });

    const followUp = await comment(item.id, "Why?", { parentCommentId: answer.id });

    expect(followUp).toMatchObject({ parentCommentId: root.id, repliedToId: answer.id });
    expect(deliveriesTo(alpha.id, "todo-reply")).toHaveLength(1);
  });

  it("wakes nobody for a reply to the operator's own comment", async () => {
    const item = store.createWorkItem({ title: "operator thread" });
    const root = await comment(item.id, "A plan.");
    const bravo = registry.createSession({ engine: "codex", source: "web", sourceRef: `bravo:${crypto.randomUUID()}`, employee: "bravo", connector: "web" });

    await comment(item.id, "Sounds good.", { as: bravo.id, parentCommentId: root.id });

    expect(delivered).toEqual([]);
  });
});

describe("delegation onto a Todo where the employee already has a session", () => {
  async function delegate(todoId: string, employee: string, headers: Record<string, string> = {}) {
    return call("POST", "/api/delegations", { workItemId: todoId, employee, task: `Take ${todoId} over.` }, headers);
  }

  it("lands in the mention session, which takes the claim and the execute role", async () => {
    const item = store.createWorkItem({ title: "mentioned, then handed over" });
    await comment(item.id, "@alpha can you look?");
    const [mentioned] = sessionsOf(item.id, "alpha");
    registry.updateSession(mentioned.id, { status: "idle" });

    const res = await delegate(item.id, "alpha");

    expect(res).toMatchObject({ status: 200, body: { sessionId: mentioned.id, reused: true } });
    expect(sessionsOf(item.id, "alpha")).toHaveLength(1);
    expect(registry.getSession(mentioned.id)?.workItemRole).toBe("execute");
    expect(claims.getWorkItemClaim(item.id)?.sessionId).toBe(mentioned.id);
    expect(deliveriesTo(mentioned.id, "todo-delegation")).toHaveLength(1);
    expect(store.getWorkItem(item.id)?.assignee).toBe("alpha");
  });

  it("delivers into the employee's own running session that already holds the claim", async () => {
    const item = store.createWorkItem({ title: "more for the worker", assignee: "worker", status: "executing" });
    const holder = executing(item.id);

    const res = await delegate(item.id, "worker");

    expect(res).toMatchObject({ status: 200, body: { sessionId: holder.id, reused: true } });
    expect(claims.getWorkItemClaim(item.id)?.sessionId).toBe(holder.id);
  });

  it("is refused while another employee's session holds the claim", async () => {
    const item = store.createWorkItem({ title: "someone else has it", assignee: "worker", status: "executing" });
    executing(item.id);
    await comment(item.id, "@alpha thoughts?");

    expect((await delegate(item.id, "alpha")).status).toBe(409);
    expect(registry.getSession(sessionsOf(item.id, "alpha")[0].id)?.workItemRole).toBe("consult");
  });

  it("records a new delegate session so a later mention lands in it", async () => {
    const item = store.createWorkItem({ title: "delegated first" });
    const res = await delegate(item.id, "bravo");
    expect(res.status).toBe(201);

    await comment(item.id, "@bravo a question");

    expect(sessionsOf(item.id, "bravo").map((session) => session.id)).toEqual([res.body.sessionId]);
    expect(deliveriesTo(res.body.sessionId, "todo-mention")).toHaveLength(1);
  });

  it("reports to the new delegator from then on, and never wakes the session's first parent", async () => {
    const item = store.createWorkItem({ title: "changing hands" });
    const firstParent = registry.createSession({ engine: "codex", source: "web", sourceRef: `p:${crypto.randomUUID()}`, employee: "org-root", connector: "web" });
    const first = await delegate(item.id, "alpha", sessionHeaders(firstParent.id));
    expect(first.status).toBe(201);
    registry.updateSession(first.body.sessionId, { status: "idle" });
    claims.releaseWorkItemClaimForSession(first.body.sessionId);
    const delegator = registry.createSession({ engine: "codex", source: "web", sourceRef: `d:${crypto.randomUUID()}`, employee: "org-root", connector: "web" });

    const second = await delegate(item.id, "alpha", sessionHeaders(delegator.id));
    expect(second).toMatchObject({ status: 200, body: { sessionId: first.body.sessionId, reused: true } });

    const child = registry.getSession(first.body.sessionId)!;
    expect(child.parentSessionId).toBe(firstParent.id);
    expect(records.reportingParentSessionId(child)).toBe(delegator.id);
    const settled = registry.updateSession(child.id, { attemptOutcome: "succeeded", attemptTerminalVersion: 1 })!;
    await callbacks.notifyParentSessionAndWait(settled, { result: "Done: took it over and finished." });
    expect(deliveriesTo(delegator.id, "parent-completion")).toHaveLength(1);
    expect(deliveriesTo(firstParent.id, "parent-completion")).toEqual([]);
  });

  it("calls nobody back when the operator delegated into the session", async () => {
    const item = store.createWorkItem({ title: "operator takes over" });
    const parent = registry.createSession({ engine: "codex", source: "web", sourceRef: `p:${crypto.randomUUID()}`, employee: "org-root", connector: "web" });
    const first = await delegate(item.id, "bravo", sessionHeaders(parent.id));
    registry.updateSession(first.body.sessionId, { status: "idle" });
    claims.releaseWorkItemClaimForSession(first.body.sessionId);

    expect((await delegate(item.id, "bravo")).body.reused).toBe(true);

    expect(records.reportingParentSessionId(registry.getSession(first.body.sessionId)!)).toBeNull();
  });
});
