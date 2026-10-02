import { describe, expect, it } from "vitest";
import { api, ctx, makeReq, makeRes, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { listWorkItemEvents } from "../../work-items/event-log.js";
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
    expect(linkEvents(id).map((event) => event.detail)).toEqual([{ sessionId: session.id, role: "execute" }]);
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
});
