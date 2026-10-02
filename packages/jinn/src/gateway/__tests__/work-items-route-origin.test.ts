import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, store } from "./helpers/work-items-route-harness.js";

/**
 * Write provenance (X-Jinn-Origin). A talk-tool write and a click in the web UI
 * both arrive as the authenticated operator, so the audit event is the only
 * place the difference can survive — and only an allowlisted declaration may
 * reach it.
 */

const talkHeaders = { ...operatorHeaders, "x-jinn-origin": "talk" };

async function call(method: string, path: string, body: unknown, headers: Record<string, string>) {
  const res = makeRes();
  await api.handleApiRequest(makeReq(method, path, body, headers), res.res, ctx);
  return res;
}

function lastEvent(workItemId: string, kind: string) {
  const event = store.listWorkItemEvents(workItemId).filter((candidate) => candidate.kind === kind).at(-1);
  expect(event, `no ${kind} event on ${workItemId}`).toBeDefined();
  return event!;
}

describe("X-Jinn-Origin write provenance on work-item events", () => {
  it("stamps a talk-issued comment with origin and leaves the same UI write unstamped", async () => {
    const item = store.createWorkItem({ title: "comment origin" });

    const viaTalk = await call("POST", `/api/work-items/${item.id}/comments`, { body: "from the orb" }, talkHeaders);
    expect(viaTalk.status).toBe(201);
    expect(lastEvent(item.id, "comment_added").detail).toMatchObject({ commentId: viaTalk.body.comment.id, origin: "talk" });

    const viaUi = await call("POST", `/api/work-items/${item.id}/comments`, { body: "from a click" }, operatorHeaders);
    expect(viaUi.status).toBe(201);
    expect(lastEvent(item.id, "comment_added").detail).toEqual({ commentId: viaUi.body.comment.id });
  });

  it("stamps the deletion that takes a talk comment back, so a reversal is not the one write the audit cannot place", async () => {
    const item = store.createWorkItem({ title: "comment undo origin" });

    const added = await call("POST", `/api/work-items/${item.id}/comments`, { body: "misheard" }, talkHeaders);
    expect(added.status).toBe(201);
    const commentId = added.body.comment.id as string;

    const removed = await call("DELETE", `/api/work-items/${item.id}/comments/${commentId}`, undefined, talkHeaders);
    expect(removed.status).toBe(200);
    expect(lastEvent(item.id, "comment_deleted").detail).toEqual({ commentId, origin: "talk" });

    const clicked = await call("POST", `/api/work-items/${item.id}/comments`, { body: "typed" }, operatorHeaders);
    const clickedId = clicked.body.comment.id as string;
    expect((await call("DELETE", `/api/work-items/${item.id}/comments/${clickedId}`, undefined, operatorHeaders)).status).toBe(200);
    expect(lastEvent(item.id, "comment_deleted").detail).toEqual({ commentId: clickedId });
  });

  it("stamps a talk-issued status write with origin as its whole detail and leaves the same UI write unstamped", async () => {
    const talked = store.createWorkItem({ title: "status origin" });
    const moved = await call("PUT", `/api/work-items/${talked.id}/status`, { status: "executing" }, talkHeaders);
    expect(moved.status).toBe(200);
    expect(lastEvent(talked.id, "status_change").detail).toMatchObject({ origin: "talk" });

    const clicked = store.createWorkItem({ title: "status no origin" });
    const alsoMoved = await call("PUT", `/api/work-items/${clicked.id}/status`, { status: "executing" }, operatorHeaders);
    expect(alsoMoved.status).toBe(200);
    expect(lastEvent(clicked.id, "status_change").detail).not.toHaveProperty("origin");

    // The banner's same-status note is the status route's other event path.
    const stalled = store.createWorkItem({ title: "status note origin", status: "blocked" });
    const annotated = await call("PUT", `/api/work-items/${stalled.id}/status`, { status: "blocked", note: "still waiting" }, talkHeaders);
    expect(annotated.status).toBe(200);
    expect(lastEvent(stalled.id, "note").detail).toEqual({ note: "still waiting", origin: "talk" });
  });

  it("threads the declared origin through create, assign, and label writes", async () => {
    const created = await call("POST", "/api/work-items", { title: "born in talk" }, talkHeaders);
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    expect(lastEvent(id, "created").detail).toMatchObject({ origin: "talk" });

    const assigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "platform-worker" }, talkHeaders);
    expect(assigned.status).toBe(200);
    // Assigning no longer moves the Todo, so it leaves a note rather than a status change.
    expect(lastEvent(id, "note").detail).toMatchObject({ assignee: "platform-worker", origin: "talk" });

    expect((await call("POST", "/api/labels", { name: "orb-tag" }, operatorHeaders)).status).toBe(201);
    const labelled = await call("PUT", `/api/work-items/${id}/labels`, { labels: ["orb-tag"] }, talkHeaders);
    expect(labelled.status).toBe(200);
    expect(lastEvent(id, "label_changed").detail).toMatchObject({ labels: ["orb-tag"], origin: "talk" });
  });

  it("ignores an unrecognised declaration instead of storing it raw or as a fallback", async () => {
    const declarations = ["mystery", "Talk", "talk-injected", '{"origin":"talk"}', "../../etc/passwd"];

    for (const declared of declarations) {
      const item = store.createWorkItem({ title: "unrecognised origin" });
      const headers = { ...operatorHeaders, "x-jinn-origin": declared };

      const commented = await call("POST", `/api/work-items/${item.id}/comments`, { body: "declared something else" }, headers);
      expect(commented.status).toBe(201);
      expect(lastEvent(item.id, "comment_added").detail).toEqual({ commentId: commented.body.comment.id });

      const moved = await call("PUT", `/api/work-items/${item.id}/status`, { status: "executing" }, headers);
      expect(moved.status).toBe(200);
      expect(lastEvent(item.id, "status_change").detail).not.toHaveProperty("origin");

      // Not stored raw anywhere in the item's audit trail, under any key.
      const audit = JSON.stringify(store.listWorkItemEvents(item.id));
      expect(audit).not.toContain(declared);
      expect(audit).not.toContain("origin");
    }
  });
});
