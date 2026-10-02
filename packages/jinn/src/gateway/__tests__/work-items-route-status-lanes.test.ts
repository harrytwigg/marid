import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { listComments } from "../../work-items/comments.js";
import { listWorkItemEvents } from "../../work-items/event-log.js";
import { reconcileActiveWorkItems } from "../../work-items/reconcile.js";
import type { WorkItemStatus } from "../../work-items/store.js";

/* The status lanes, decided at the route every status tool calls: the
 * operator's surfaces walk every edge, the coordinator may close as done with a
 * reason, and every other session stays inside the open statuses. */

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, path, body, headers), cap.res, ctx);
  return cap;
}
const post = (id: string, body: unknown, headers: Record<string, string>) => call("POST", `/api/work-items/${id}/status`, body, headers);
const archive = (id: string, body: unknown, headers: Record<string, string>) => call("POST", `/api/work-items/${id}/archive`, body, headers);

let n = 0;
function employeeSession() {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: `lane-employee-${++n}`, employee: "solo-worker" });
}
function coordinatorSession(overrides: Partial<Parameters<typeof reg.createSession>[0]> = {}) {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: `web:lane-${++n}`, ...overrides });
}
function connectorSession() {
  return reg.createSession({ engine: "codex", source: "remote-mcp", sourceRef: `remote-mcp:op-${++n}@example.com` });
}
function todo(status: WorkItemStatus, title = `Lane ${status} ${++n}`) {
  return store.createWorkItem({ title, status, assignee: "platform-worker" });
}

describe("the agent lane", () => {
  it.each([
    ["backlog", "executing"],
    ["executing", "backlog"],
    ["executing", "in_review"],
    ["in_review", "executing"],
    ["backlog", "blocked"],
    ["executing", "blocked"],
    ["in_review", "blocked"],
    ["blocked", "backlog"],
    ["blocked", "executing"],
    ["blocked", "in_review"],
  ] as const)("lets any employee session move %s → %s", async (from, to) => {
    const item = todo(from);
    const cap = await post(item.id, { status: to, note: "agent lane" }, toolHeaders(employeeSession().id));
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, to]);
  });

  it.each([
    ["in_review", "done"],
    ["executing", "done"],
    ["executing", "cancelled"],
    ["backlog", "in_review"],
    ["in_review", "backlog"],
    ["done", "backlog"],
    ["cancelled", "backlog"],
  ] as const)("refuses an employee session %s → %s and leaves the Todo where it was", async (from, to) => {
    const item = todo(from);
    const cap = await post(item.id, { status: to }, toolHeaders(employeeSession().id));
    expect(cap.status).toBe(403);
    expect(store.getWorkItem(item.id)?.status).toBe(from);
  });

  it("refuses done to a session linked as the Todo's reviewer, too", async () => {
    const item = todo("in_review");
    const reviewer = employeeSession();
    store.linkSession(item.id, reviewer.id, null, "review");
    const cap = await post(item.id, { status: "done" }, toolHeaders(reviewer.id));
    expect(cap.status).toBe(403);
    expect(cap.body.error).toMatch(/operator's decision/);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");
  });

  it.each(["assigned", "escalated"])("refuses the retired status %s on every surface", async (status) => {
    const item = todo("backlog");
    for (const headers of [operatorHeaders, toolHeaders(employeeSession().id)]) {
      const cap = await post(item.id, { status, note: "retired" }, headers);
      expect(cap.status).toBe(400);
    }
    expect(store.getWorkItem(item.id)?.status).toBe("backlog");
  });

  it("refuses archive to every agent session, the Todo's creator included", async () => {
    const creator = employeeSession();
    const created = await call("POST", "/api/work-items", { title: "Created by an agent" }, toolHeaders(creator.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    for (const session of [creator, coordinatorSession()]) {
      const cap = await archive(id, {}, toolHeaders(session.id));
      expect(cap.status).toBe(403);
    }
    expect(store.getWorkItem(id)?.status).toBe("backlog");
  });
});

describe("the coordinator's done lane", () => {
  it("closes an executing Todo for the operator and posts the reason under its session", async () => {
    const item = todo("executing");
    const coo = coordinatorSession();
    const cap = await post(item.id, { status: "done", asOperator: true, note: "the operator shipped it by hand" }, toolHeaders(coo.id));
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "done"]);

    const event = listWorkItemEvents(item.id).find((e) => e.toStatus === "done")!;
    expect(event).toMatchObject({ toStatus: "done", actor: "operator" });
    expect(event.detail).toMatchObject({ asOperator: `session:${coo.id}`, note: "the operator shipped it by hand" });
    const comment = listComments(item.id).comments.at(-1)!;
    expect(comment.author).toBe(`session:${coo.id}`);
    expect(comment.body).toContain("the operator shipped it by hand");
  });

  it("refuses the same call without a reason", async () => {
    const item = todo("executing");
    const cap = await post(item.id, { status: "done", asOperator: true }, toolHeaders(coordinatorSession().id));
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/reason in note/);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
  });

  it.each(["cancelled", "in_review", "backlog"] as const)("refuses asOperator with %s", async (status) => {
    const item = todo("executing");
    const cap = await post(item.id, { status, asOperator: true, note: "on the operator's word" }, toolHeaders(coordinatorSession().id));
    expect(cap.status).toBe(403);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
  });

  it("refuses asOperator from an employee session, and to reopen closed work", async () => {
    const live = todo("executing");
    const byEmployee = await post(live.id, { status: "done", asOperator: true, note: "x" }, toolHeaders(employeeSession().id));
    expect(byEmployee.status).toBe(403);
    expect(byEmployee.body.error).toMatch(/coordinator session/);

    const closed = todo("done");
    const reopen = await post(closed.id, { status: "done", asOperator: true, note: "x" }, toolHeaders(coordinatorSession().id));
    expect(reopen.status).toBe(403);
  });

  it.each([
    ["a cron run", { source: "cron", sourceRef: "cron:job-1:2026-01-01T00:00:00Z" }],
    ["an engine-only delegation", { sessionKey: "delegation:TST-1:abc", sourceRef: "delegation:TST-1:abc" }],
    ["a connector anchor", { source: "remote-mcp", sourceRef: "remote-mcp:someone@example.com" }],
    ["a child session", { parentSessionId: "parent-session" }],
  ] as const)("does not treat %s as the coordinator", async (_label, overrides) => {
    const session = coordinatorSession(overrides as Partial<Parameters<typeof reg.createSession>[0]>);
    expect(reg.isCoordinatorSession(session)).toBe(false);
  });

  it("treats web, Talk and chat-connector top-level sessions as the coordinator", () => {
    for (const source of ["web", "talk", "telegram", "slack"]) {
      expect(reg.isCoordinatorSession(coordinatorSession({ source, sourceRef: `${source}:chat-${++n}` }))).toBe(true);
    }
  });
});

describe("the operator lane", () => {
  it("lets the remote connector close, cancel, reopen and archive", async () => {
    const connector = toolHeaders(connectorSession().id);
    const closing = todo("executing");
    expect((await post(closing.id, { status: "done" }, connector)).body.workItem?.status).toBe("done");
    expect((await post(closing.id, { status: "backlog" }, connector)).body.workItem?.status).toBe("backlog");

    const cancelling = todo("in_review");
    expect((await post(cancelling.id, { status: "cancelled" }, connector)).body.workItem?.status).toBe("cancelled");

    const archiving = todo("blocked");
    const archived = await archive(archiving.id, {}, connector);
    expect([archived.status, archived.body.workItem?.status]).toEqual([200, "cancelled"]);
  });

  it("keeps a connector's reopen where it put it: older attempts do not overrule the operator's lane", async () => {
    const connector = toolHeaders(connectorSession().id);
    const settledRun = (id: string, attemptOutcome: "failed" | "succeeded") => {
      const attempt = reg.createSession({ engine: "codex", source: "web", sourceRef: `lane-attempt-${++n}` });
      store.linkSession(id, attempt.id);
      reg.updateSession(attempt.id, { status: attemptOutcome === "failed" ? "error" : "idle", attemptOutcome });
    };
    const reopened = store.createWorkItem({ title: "Reopened by the connector", status: "executing" });
    settledRun(reopened.id, "failed");
    expect((await post(reopened.id, { status: "done" }, connector)).body.workItem?.status).toBe("done");
    expect((await post(reopened.id, { status: "backlog" }, connector)).body.workItem?.status).toBe("backlog");

    // A trust-tier Todo whose last attempt succeeded would otherwise be re-closed.
    const trusted = store.createWorkItem({ title: "Trusted, reopened", status: "executing", source: "cron" });
    settledRun(trusted.id, "succeeded");
    expect((await post(trusted.id, { status: "done" }, connector)).body.workItem?.status).toBe("done");
    expect((await post(trusted.id, { status: "backlog" }, connector)).body.workItem?.status).toBe("backlog");

    reconcileActiveWorkItems();
    expect(store.getWorkItem(reopened.id)?.status).toBe("backlog");
    expect(store.getWorkItem(trusted.id)?.status).toBe("backlog");
  });

  it("lets the operator close and reopen from the board", async () => {
    const item = todo("in_review");
    expect((await call("PUT", `/api/work-items/${item.id}/status`, { status: "done" }, operatorHeaders)).body.workItem?.status).toBe("done");
    expect((await call("PUT", `/api/work-items/${item.id}/status`, { status: "backlog" }, operatorHeaders)).body.workItem?.status).toBe("backlog");
  });
});

describe("review on create", () => {
  it("refuses a review policy from anyone, so the reconciler cannot close an agent's own work", async () => {
    const session = employeeSession();
    const refused = await call("POST", "/api/work-items", { title: "Trust me", verifyPolicy: { mode: "trust" } }, toolHeaders(session.id));
    expect(refused.status).toBe(400);
    const operator = await call("POST", "/api/work-items", { title: "Operator trusts", verifyPolicy: { mode: "trust" } }, operatorHeaders);
    expect(operator.status).toBe(400);

    const created = await call("POST", "/api/work-items", { title: "Agent work" }, toolHeaders(session.id));
    const id = created.body.workItem.id as string;
    expect((await post(id, { status: "executing" }, toolHeaders(session.id))).status).toBe(200);
    expect((await post(id, { status: "in_review", note: "ready for the operator" }, toolHeaders(session.id))).status).toBe(200);
    reconcileActiveWorkItems();
    expect(store.getWorkItem(id)?.status).toBe("in_review");
  });
});

describe("assignment", () => {
  it("keeps the Todo in backlog, and takes the operator as an assignee", async () => {
    const item = store.createWorkItem({ title: "Assign me" });
    const toEmployee = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "platform-worker" }, operatorHeaders);
    expect([toEmployee.status, toEmployee.body.workItem?.status, toEmployee.body.workItem?.assignee]).toEqual([200, "backlog", "platform-worker"]);
    const toOperator = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "@operator" }, operatorHeaders);
    expect([toOperator.status, toOperator.body.workItem?.status, toOperator.body.workItem?.assignee]).toEqual([200, "backlog", "@operator"]);
  });

  it("lets the operator's pen restore @operator, and refuses it a system employee", async () => {
    const item = store.createWorkItem({ title: "Pen restore" });
    const restored = await call("PATCH", `/api/work-items/${item.id}`, { expectedVersion: item.version, assignee: "@operator" }, operatorHeaders);
    expect([restored.status, restored.body.workItem?.assignee]).toEqual([200, "@operator"]);
    const system = await call("PATCH", `/api/work-items/${item.id}`, { expectedVersion: restored.body.workItem.version, assignee: "todo-dispatcher" }, operatorHeaders);
    expect([system.status, system.body.code]).toEqual([400, "todo_invalid_assignee"]);
  });

  it("puts a blocked Todo the operator holds in the operator's own attention queue, and in nobody else's", async () => {
    const held = store.createWorkItem({ title: "Blocked on the operator", status: "blocked", assignee: "@operator" });
    const ids = async (headers: Record<string, string>) =>
      ((await call("GET", "/api/work-items?needsAttentionFor=me&limit=200", undefined, headers)).body.workItems as Array<{ id: string }>).map((row) => row.id);
    expect(await ids(operatorHeaders)).toContain(held.id);
    expect(await ids(toolHeaders(employeeSession().id))).not.toContain(held.id);
  });

  // A dead end the Dispatcher or Shaper stopped for the operator keeps its
  // assignee, which for a shaped capture is nobody: it must still reach them.
  it("puts a blocked Todo nobody holds in the operator's queue, and not a blocked one an employee holds", async () => {
    const unheld = store.createWorkItem({ title: "Dead end, nobody holds it", status: "blocked" });
    const employeeHeld = store.createWorkItem({ title: "Blocked on its worker", status: "blocked", assignee: "platform-worker" });
    const ids = async (headers: Record<string, string>) =>
      ((await call("GET", "/api/work-items?needsAttentionFor=me&limit=200", undefined, headers)).body.workItems as Array<{ id: string }>).map((row) => row.id);
    const operatorQueue = await ids(operatorHeaders);
    expect(operatorQueue).toContain(unheld.id);
    expect(operatorQueue).not.toContain(employeeHeld.id);
    expect(await ids(toolHeaders(employeeSession().id))).not.toContain(unheld.id);
  });

  it.each(["todo-dispatcher", "todo-shaper"])("never assigns the system employee %s, by assign or by delegation", async (name) => {
    const item = store.createWorkItem({ title: `Not for ${name}` });
    const assigned = await call("POST", `/api/work-items/${item.id}/assign`, { assignee: name }, operatorHeaders);
    expect(assigned.status).toBe(400);
    expect(assigned.body.error).toMatch(/system employee/);
    const delegated = await call("POST", "/api/delegations", { employee: name, task: "route it", workItemId: item.id }, operatorHeaders);
    expect(delegated.status).toBe(400);
    expect(delegated.body.error).toMatch(/system employee/);
    expect(store.getWorkItem(item.id)?.assignee).toBeNull();
  });
});
