import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";
import { listComments } from "../../work-items/comments.js";
import type { WorkItemStatus } from "../../work-items/store.js";

/* Handing work to review is a handoff the operator reads: an agent session
 * moving a Todo into in_review carries a summary, and the gateway posts it as a
 * comment under the caller's own session. Comment writes stamp that session from
 * the verified caller, never from the request body. */

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const cap = makeRes();
  await api.handleApiRequest(makeReq(method, path, body, headers), cap.res, ctx);
  return cap;
}
const post = (id: string, body: unknown, headers: Record<string, string>) => call("POST", `/api/work-items/${id}/status`, body, headers);
const put = (id: string, body: unknown) => call("PUT", `/api/work-items/${id}/status`, body, operatorHeaders);
const comment = (id: string, body: unknown, headers: Record<string, string>) => call("POST", `/api/work-items/${id}/comments`, body, headers);

let n = 0;
function employeeSession() {
  return reg.createSession({ engine: "codex", source: "web", sourceRef: `handoff-employee-${++n}`, employee: "solo-worker" });
}
function connectorSession() {
  return reg.createSession({ engine: "codex", source: "remote-mcp", sourceRef: `remote-mcp:handoff-${++n}@example.com` });
}
function todo(status: WorkItemStatus) {
  return store.createWorkItem({ title: `Handoff ${status} ${++n}`, status, assignee: "platform-worker" });
}

describe("the agent lane's review handoff", () => {
  it("refuses executing → in_review without a summary and leaves the Todo where it was", async () => {
    const item = todo("executing");
    const cap = await post(item.id, { status: "in_review" }, toolHeaders(employeeSession().id));
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/summary/);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
    expect(listComments(item.id).comments).toHaveLength(0);
  });

  it("treats a whitespace-only note as no summary", async () => {
    const item = todo("executing");
    const cap = await post(item.id, { status: "in_review", note: "   " }, toolHeaders(employeeSession().id));
    expect(cap.status).toBe(400);
    expect(store.getWorkItem(item.id)?.status).toBe("executing");
  });

  it("moves the Todo and posts the summary as a comment under the caller's session", async () => {
    const item = todo("executing");
    const session = employeeSession();
    const cap = await post(item.id, { status: "in_review", note: "Shipped the fix; evidence is in the PR." }, toolHeaders(session.id));
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "in_review"]);

    const posted = listComments(item.id).comments;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      body: "Shipped the fix; evidence is in the PR.",
      author: "solo-worker",
      authorKind: "employee",
      sessionId: session.id,
    });
  });

  it("does not need a summary for a same-status in_review move, and posts nothing", async () => {
    const item = todo("in_review");
    const cap = await post(item.id, { status: "in_review" }, toolHeaders(employeeSession().id));
    expect(cap.status).toBe(200);
    expect(cap.body.workItem?.status).toBe("in_review");
    expect(listComments(item.id).comments).toHaveLength(0);
  });

  // The move commits before its comment does: a caller whose comment write
  // failed sends the same move again, and the handoff must still land, once.
  it("posts the handoff on a retried move whose first comment never landed, and only once", async () => {
    const item = todo("executing");
    const session = employeeSession();
    const { transition } = await import("../../work-items/transitions.js");
    transition(item.id, "in_review", `session:${session.id}`, { manual: true, agent: true, detail: { note: "Done; evidence in the PR." } });
    expect(listComments(item.id).comments).toHaveLength(0);

    for (let attempt = 0; attempt < 2; attempt++) {
      const cap = await post(item.id, { status: "in_review", note: "Done; evidence in the PR." }, toolHeaders(session.id));
      expect(cap.status).toBe(200);
    }
    const posted = listComments(item.id).comments;
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ body: "Done; evidence in the PR.", sessionId: session.id });
  });

  it("does not post another caller's handoff on its same-status move", async () => {
    const item = todo("executing");
    const { transition } = await import("../../work-items/transitions.js");
    transition(item.id, "in_review", `session:${employeeSession().id}`, { manual: true, agent: true, detail: { note: "mine" } });
    await post(item.id, { status: "in_review" }, toolHeaders(employeeSession().id));
    expect(listComments(item.id).comments).toHaveLength(0);
  });

  it("does not need a summary to leave review", async () => {
    const item = todo("in_review");
    const cap = await post(item.id, { status: "executing" }, toolHeaders(employeeSession().id));
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "executing"]);
  });
});

describe("the operator lane's review handoff", () => {
  it("moves a Todo into in_review without a note and posts no comment", async () => {
    const item = todo("executing");
    const cap = await put(item.id, { status: "in_review" });
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "in_review"]);
    expect(listComments(item.id).comments).toHaveLength(0);
  });

  it("posts a given note as the operator's comment, with no session", async () => {
    const item = todo("executing");
    const cap = await put(item.id, { status: "in_review", note: "looks ready to me" });
    expect(cap.status).toBe(200);
    const [posted] = listComments(item.id).comments;
    expect(posted).toMatchObject({ body: "looks ready to me", author: "operator", authorKind: "operator" });
    expect(posted).not.toHaveProperty("sessionId");
  });

  it("lets the remote connector's session move into in_review without a note", async () => {
    const item = todo("executing");
    const cap = await post(item.id, { status: "in_review" }, toolHeaders(connectorSession().id));
    expect([cap.status, cap.body.workItem?.status]).toEqual([200, "in_review"]);
    expect(listComments(item.id).comments).toHaveLength(0);
  });
});

describe("comment POST session stamping", () => {
  it("stamps the caller's session, and never one the request body names", async () => {
    const item = store.createWorkItem({ title: "stamped comment" });
    const session = employeeSession();
    const cap = await comment(item.id, { body: "from an agent", sessionId: "forged-session" }, toolHeaders(session.id));
    expect(cap.status).toBe(201);
    expect(cap.body.comment.sessionId).toBe(session.id);
    expect(listComments(item.id).comments[0]?.sessionId).toBe(session.id);
  });

  it("leaves the operator's comments without a session", async () => {
    const item = store.createWorkItem({ title: "operator comment" });
    const cap = await comment(item.id, { body: "from the operator", sessionId: "forged-session" }, operatorHeaders);
    expect(cap.status).toBe(201);
    expect(cap.body.comment).not.toHaveProperty("sessionId");
  });

  it("records who a reply to a reply actually answered", async () => {
    const item = store.createWorkItem({ title: "threaded comments" });
    const root = (await comment(item.id, { body: "root" }, operatorHeaders)).body.comment;
    const first = (await comment(item.id, { body: "first reply", parentCommentId: root.id }, operatorHeaders)).body.comment;
    const nested = (await comment(item.id, { body: "reply to the reply", parentCommentId: first.id }, toolHeaders(employeeSession().id))).body.comment;

    expect(first).toMatchObject({ parentCommentId: root.id, repliedToId: root.id });
    expect(nested).toMatchObject({ parentCommentId: root.id, repliedToId: first.id });
  });
});

describe("the Todo's session tree", () => {
  it("names a session that only commented, though no actor string mentions it", async () => {
    const item = store.createWorkItem({ title: "tree from comments" });
    const session = employeeSession();
    // The comment's author is the employee name, so the session id reaches the
    // tree only through the comment's recorded session.
    await comment(item.id, { body: "I looked at this" }, toolHeaders(session.id));

    const cap = await call("GET", `/api/work-items/${item.id}/sessions?tree=1`, undefined, operatorHeaders);
    expect(cap.status).toBe(200);
    expect(cap.body.directory[session.id]).toMatchObject({ id: session.id, employee: "solo-worker", missing: false });
  });
});
