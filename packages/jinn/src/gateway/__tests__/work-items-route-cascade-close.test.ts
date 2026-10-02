import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* PLA-96: one operator action closes a container and everything open under it.
 * The route decides WHO may ask for that — closing a tree touches work the
 * caller never opened, so it is the human surface's move alone. */

/** The operator's real case: an `in_review` root over two open generations. */
function openTree(label: string, leafStatus?: "blocked") {
  const parent = store.createWorkItem({ title: `${label} parent`, status: "in_review" });
  const mid = store.createWorkItem({ title: `${label} mid`, parentId: parent.id });
  const leaf = store.createWorkItem({ title: `${label} leaf`, parentId: mid.id, ...(leafStatus ? { status: leafStatus } : {}) });
  return { parent, mid, leaf };
}

const statusesOf = (ids: readonly string[]) => ids.map((id) => store.getWorkItem(id)!.status);

describe("PUT|POST /api/work-items/:id/status — cascade close", () => {
  it("closes the whole subtree on an operator PUT that asks for it", async () => {
    const { parent, mid, leaf } = openTree("Cascade");
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${parent.id}/status`, { status: "done", cascade: true }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(statusesOf([parent.id, mid.id, leaf.id])).toEqual(["done", "done", "done"]);
  });

  it("refuses a session caller's cascade and leaves the tree exactly as it was", async () => {
    const { parent, mid, leaf } = openTree("Session cascade");
    const caller = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "web:cascade-caller",
      employee: "platform-worker",
    });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${parent.id}/status`, { status: "done", cascade: true }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toMatch(/operator-surface decision/i);
    expect(statusesOf([parent.id, mid.id, leaf.id])).toEqual(["in_review", "backlog", "backlog"]);
  });

  it("refuses cascade on any target but done", async () => {
    const { parent } = openTree("Wrong target");
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${parent.id}/status`, { status: "blocked", cascade: true }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/done update only/);
    expect(store.getWorkItem(parent.id)!.status).toBe("in_review");
  });

  it("refuses a non-boolean cascade rather than reading it as truthy", async () => {
    const { parent } = openTree("Loose cascade");
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${parent.id}/status`, { status: "done", cascade: "yes" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body.error).toBe("cascade must be a boolean");
  });

  it("closes the tree over a blocked descendant in one call, with no acknowledgement step", async () => {
    const { parent, mid, leaf } = openTree("Blocked leaf", "blocked");
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${parent.id}/status`, { status: "done", cascade: true }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(statusesOf([parent.id, mid.id, leaf.id])).toEqual(["done", "done", "done"]);
  });
});
