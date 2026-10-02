import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { listWorkItemEvents } from "../../work-items/event-log.js";
import { reconcileWorkItem } from "../../work-items/reconcile.js";
import { setJinnAttachGate } from "../../mcp/attachment.js";
import { listWorkItemRuns, openWorkItemRun } from "../../work-items/runs.js";

/* A session that creates a Todo, assigns it to its own employee and starts it
 * goes through no dispatch, so the routes themselves link it to the Todo as its
 * executing session and open its run — the same record a dispatched Todo has. */

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, path, body, headers), cap.res, ctx);
  return cap;
}

let n = 0;
function workerSession() {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: `web:self-start-${++n}`, employee: "solo-worker", prompt: "work" });
}

async function createOwnTodo(sessionId: string, title = `Self-started ${++n}`): Promise<string> {
  const created = await call("POST", "/api/work-items", { title, autoStart: false }, toolHeaders(sessionId));
  expect([created.status, created.body.error]).toEqual([201, undefined]);
  return created.body.workItem.id as string;
}

const assign = (id: string, assignee: string, sessionId: string) =>
  call("POST", `/api/work-items/${id}/assign`, { assignee }, toolHeaders(sessionId));
const move = (id: string, status: string, sessionId: string, note?: string) =>
  call("POST", `/api/work-items/${id}/status`, { status, ...(note ? { note } : {}) }, toolHeaders(sessionId));

function linkEvents(id: string) {
  return listWorkItemEvents(id).filter((event) => event.kind === "session_linked");
}

describe("a Todo its own session starts", () => {
  it("links the session as its executor and opens its run when it creates, self-assigns and starts it", async () => {
    const session = workerSession();
    const id = await createOwnTodo(session.id);
    expect((await assign(id, "solo-worker", session.id)).status).toBe(200);
    // Assigning starts nothing, so it links nothing either.
    expect(linkEvents(id)).toHaveLength(0);

    const started = await move(id, "executing", session.id);
    expect([started.status, started.body.workItem.status]).toEqual([200, "executing"]);
    // The version handed back is the one a next write must quote.
    expect(started.body.workItem.version).toBe(store.getWorkItem(id)?.version);

    expect(reg.getSession(session.id)).toMatchObject({ workItemId: id, workItemRole: "execute" });
    expect(linkEvents(id).map((event) => event.detail)).toEqual([{ sessionId: session.id, role: "execute", selfStarted: true }]);
    expect(listWorkItemRuns(id)).toMatchObject([{ sessionId: session.id, endedAt: null, outcome: null }]);

    const read = await call("GET", `/api/work-items/${id}`, undefined, toolHeaders(session.id));
    expect(read.body.runs).toMatchObject([{ sessionId: session.id }]);
    const linked = await call("GET", `/api/work-items/${id}/sessions`, undefined, toolHeaders(session.id));
    expect(JSON.stringify(linked.body)).toContain(session.id);
  });

  it("links it when the session starts the Todo first and assigns it to itself after", async () => {
    const session = workerSession();
    const id = await createOwnTodo(session.id);
    expect((await move(id, "executing", session.id)).status).toBe(200);
    expect(linkEvents(id)).toHaveLength(0);
    const assigned = await assign(id, "solo-worker", session.id);
    expect(assigned.status).toBe(200);
    expect(assigned.body.workItem.version).toBe(store.getWorkItem(id)?.version);
    expect(reg.getSession(session.id)?.workItemId).toBe(id);
    expect(listWorkItemRuns(id).map((run) => run.sessionId)).toEqual([session.id]);
  });

  it("does not link the creator to a Todo it handed to somebody else", async () => {
    const session = workerSession();
    const id = await createOwnTodo(session.id);
    expect((await assign(id, "platform-worker", session.id)).status).toBe(200);
    expect((await move(id, "executing", session.id)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId ?? null).toBeNull();
    expect(linkEvents(id)).toHaveLength(0);
    expect(listWorkItemRuns(id)).toEqual([]);
  });

  it("leaves a session on the open Todo it is already executing", async () => {
    const session = workerSession();
    const first = store.createWorkItem({ title: `Already working ${++n}`, status: "executing", assignee: "solo-worker" });
    store.linkSession(first.id, session.id, null, "execute");
    const id = await createOwnTodo(session.id);
    expect((await assign(id, "solo-worker", session.id)).status).toBe(200);
    expect((await move(id, "executing", session.id)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId).toBe(first.id);
    expect(linkEvents(id)).toHaveLength(0);
  });

  it("moves on from a Todo it has already handed to review", async () => {
    const session = workerSession();
    const first = store.createWorkItem({ title: `Handed over ${++n}`, status: "in_review", assignee: "solo-worker" });
    store.linkSession(first.id, session.id, null, "execute");
    openWorkItemRun({ workItemId: first.id, sessionId: session.id });
    const id = await createOwnTodo(session.id);
    expect((await assign(id, "solo-worker", session.id)).status).toBe(200);
    expect((await move(id, "executing", session.id)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId).toBe(id);
    // The finished attempt stays on the first Todo's ledger.
    expect(listWorkItemRuns(first.id).map((run) => run.sessionId)).toEqual([session.id]);
  });

  it("adds no second link or run for a session already executing the Todo", async () => {
    const session = workerSession();
    const item = store.createWorkItem({ title: `Dispatched ${++n}`, status: "blocked", assignee: "solo-worker" });
    store.linkSession(item.id, session.id, null, "execute");
    openWorkItemRun({ workItemId: item.id, sessionId: session.id });
    expect((await move(item.id, "executing", session.id)).status).toBe(200);
    expect(linkEvents(item.id)).toHaveLength(1);
    expect(listWorkItemRuns(item.id)).toHaveLength(1);
  });

  it("keeps a reviewer's link a review link", async () => {
    const session = workerSession();
    const item = store.createWorkItem({ title: `Reviewed ${++n}`, status: "backlog", assignee: "solo-worker" });
    store.linkSession(item.id, session.id, null, "review");
    expect((await move(item.id, "executing", session.id)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemRole).toBe("review");
    expect(listWorkItemRuns(item.id)).toEqual([]);
  });

  it("opens a new run when the producer takes its Todo back from review to rework it", async () => {
    const session = workerSession();
    const id = await createOwnTodo(session.id);
    await assign(id, "solo-worker", session.id);
    await move(id, "executing", session.id);
    settleTurn(session.id);
    reconcileWorkItem(id);
    expect((await move(id, "in_review", session.id, "done")).status).toBe(200);
    turnStarts(session.id);
    expect((await move(id, "executing", session.id)).status).toBe(200);
    expect(listWorkItemRuns(id).map((run) => [run.sessionId, run.outcome])).toEqual([[session.id, "completed"], [session.id, null]]);
    expect(linkEvents(id)).toHaveLength(1);
  });
});

/** A chat turn ends cleanly, and a later one starts. */
function settleTurn(sessionId: string) {
  reg.updateSession(sessionId, { status: "idle", attemptOutcome: "succeeded", lastActivity: new Date().toISOString() });
}
function turnStarts(sessionId: string) {
  reg.updateSession(sessionId, { status: "running", lastActivity: new Date(Date.now() + 1000).toISOString() });
}

async function selfStarted(): Promise<{ sessionId: string; id: string }> {
  const session = workerSession();
  turnStarts(session.id);
  const id = await createOwnTodo(session.id);
  await assign(id, "solo-worker", session.id);
  expect((await move(id, "executing", session.id)).status).toBe(200);
  expect(reg.getSession(session.id)?.workItemId).toBe(id);
  return { sessionId: session.id, id };
}

describe("a self-started Todo put back in the backlog", () => {
  it("stays parked when the operator parks it and the chat goes on to an unrelated turn", async () => {
    const { sessionId, id } = await selfStarted();
    settleTurn(sessionId);
    const parked = await call("PUT", `/api/work-items/${id}/status`, { status: "backlog" }, operatorHeaders);
    expect([parked.status, parked.body.workItem?.status]).toEqual([200, "backlog"]);
    expect(reg.getSession(sessionId)?.workItemId ?? null).toBeNull();
    const event = listWorkItemEvents(id).filter((entry) => entry.kind === "status_change").at(-1);
    expect(event?.detail).toMatchObject({ releasedSessions: [sessionId] });

    turnStarts(sessionId);
    reconcileWorkItem(id);
    expect(store.getWorkItem(id)?.status).toBe("backlog");
    // The attempt it made stays on the ledger.
    expect(listWorkItemRuns(id).map((run) => run.sessionId)).toEqual([sessionId]);
  });

  it("stays parked when the agent parks it itself in the middle of a turn", async () => {
    const { sessionId, id } = await selfStarted();
    expect((await move(id, "backlog", sessionId)).status).toBe(200);
    reconcileWorkItem(id);
    expect(store.getWorkItem(id)?.status).toBe("backlog");
    // Starting it again links it again.
    expect((await move(id, "executing", sessionId)).status).toBe(200);
    expect(reg.getSession(sessionId)?.workItemId).toBe(id);
  });

  it("keeps a dispatched attempt's link, which was never self-started", async () => {
    const session = workerSession();
    const item = store.createWorkItem({ title: `Dispatched ${++n}`, status: "executing", assignee: "solo-worker" });
    store.linkSession(item.id, session.id, null, "execute");
    settleTurn(session.id);
    expect((await call("PUT", `/api/work-items/${item.id}/status`, { status: "backlog" }, operatorHeaders)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId).toBe(item.id);
  });
});

describe("a self-started Todo handed to somebody else", () => {
  // The Dispatcher refuses to start until the gateway's toolset is verified;
  // this harness has no engines, so past that it stops at the engine lookup.
  // What matters is that it no longer finds an attempt already executing.
  beforeAll(() => setJinnAttachGate({ ok: true }));
  afterAll(() => setJinnAttachGate(null));

  it("takes the old chat off it, so the new owner can be dispatched while that chat runs", async () => {
    const { sessionId, id } = await selfStarted();
    const reassigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "platform-worker" }, operatorHeaders);
    expect([reassigned.status, reassigned.body.workItem?.assignee]).toEqual([200, "platform-worker"]);
    expect(reg.getSession(sessionId)?.workItemId ?? null).toBeNull();
    expect(reg.listSessionsByWorkItem(id)).toEqual([]);
    const event = listWorkItemEvents(id).filter((entry) => entry.kind === "note").at(-1);
    expect(event?.detail).toMatchObject({ assignee: "platform-worker", releasedSessions: [sessionId] });

    expect(reg.getSession(sessionId)?.status).toBe("running");
    const dispatched = await call("POST", `/api/work-items/${id}/dispatch`, {}, operatorHeaders);
    expect([dispatched.status, dispatched.body.code]).not.toEqual([409, "TODO_ALREADY_EXECUTING"]);
    expect(dispatched.body.code).toBeUndefined();
  });

  it.each([
    ["to nobody", null],
    ["to another employee", "platform-worker"],
  ] as const)("takes the old chat off it when the operator's edit gives it %s", async (_label, assignee) => {
    const { sessionId, id } = await selfStarted();
    const expectedVersion = store.getWorkItem(id)!.version;
    const edited = await call("PATCH", `/api/work-items/${id}`, { assignee, expectedVersion }, operatorHeaders);
    expect([edited.status, store.getWorkItem(id)?.assignee]).toEqual([200, assignee]);
    expect(reg.getSession(sessionId)?.workItemId ?? null).toBeNull();
    const event = listWorkItemEvents(id).filter((entry) => entry.kind === "metadata_edited").at(-1);
    expect(event?.detail).toMatchObject({ updatedFields: ["assignee"], releasedSessions: [sessionId] });

    expect(reg.getSession(sessionId)?.status).toBe("running");
    const dispatched = await call("POST", `/api/work-items/${id}/dispatch`, {}, operatorHeaders);
    expect(dispatched.body.code).toBeUndefined();
  });

  it("takes the old chat off it when a trusted internal write changes the assignee", async () => {
    const { sessionId, id } = await selfStarted();
    store.updateWorkItem(id, { assignee: "platform-worker" }, "operator");
    expect(reg.getSession(sessionId)?.workItemId ?? null).toBeNull();
    const event = listWorkItemEvents(id).filter((entry) => entry.kind === "note").at(-1);
    expect(event?.detail).toMatchObject({ releasedSessions: [sessionId] });
  });

  it("keeps a dispatched attempt's link through the operator's edit, as before", async () => {
    const session = workerSession();
    const item = store.createWorkItem({ title: `Dispatched ${++n}`, status: "executing", assignee: "solo-worker" });
    store.linkSession(item.id, session.id, null, "execute");
    const expectedVersion = store.getWorkItem(item.id)!.version;
    expect((await call("PATCH", `/api/work-items/${item.id}`, { assignee: null, expectedVersion }, operatorHeaders)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId).toBe(item.id);
  });

  it("keeps a dispatched attempt's link through a reassignment, as before", async () => {
    const session = workerSession();
    const item = store.createWorkItem({ title: `Dispatched ${++n}`, status: "executing", assignee: "solo-worker" });
    store.linkSession(item.id, session.id, null, "execute");
    expect((await call("POST", `/api/work-items/${item.id}/assign`, { assignee: "platform-worker" }, operatorHeaders)).status).toBe(200);
    expect(reg.getSession(session.id)?.workItemId).toBe(item.id);
  });
});

describe("calls that start nothing", () => {
  it("do not pull a second session of the same employee onto a Todo already being worked", async () => {
    const { sessionId, id } = await selfStarted();
    const other = workerSession();
    expect((await move(id, "executing", other.id)).status).toBe(200);
    expect((await assign(id, "solo-worker", other.id)).status).toBe(200);
    expect(reg.getSession(other.id)?.workItemId ?? null).toBeNull();
    expect(listWorkItemRuns(id).map((run) => run.sessionId)).toEqual([sessionId]);
  });

  it("link no session that carries no employee, such as the coordinator's", async () => {
    const coordinator = reg.createSession({ engine: "codex", source: "web", sourceRef: `web:self-start-coo-${++n}`, prompt: "coordinate" });
    const item = store.createWorkItem({ title: `Coordinated ${++n}`, status: "backlog", assignee: "solo-worker" });
    expect((await move(item.id, "executing", coordinator.id)).status).toBe(200);
    expect(reg.getSession(coordinator.id)?.workItemId ?? null).toBeNull();
  });
});
