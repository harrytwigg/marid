import { describe, it, expect } from "vitest";
import { api, ctx, emittedEvents, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

describe("Todos v2 slice 2 — comment edit and delete authority", () => {
  it("PATCH/DELETE enforce author-or-operator authority and tombstone semantics", async () => {
    const item = store.createWorkItem({ title: "comment authz item" });
    const authorSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-author", employee: "platform-worker" });
    const strangerSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-stranger" });

    const posted = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "original" }, toolHeaders(authorSession.id)),
      posted.res,
      ctx,
    );
    const comment = posted.body.comment;

    // A different (bare) session may not edit or delete someone else's comment.
    const strangerEdit = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "hijack" }, toolHeaders(strangerSession.id)),
      strangerEdit.res,
      ctx,
    );
    expect(strangerEdit.status).toBe(403);
    const strangerDelete = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${comment.id}`, undefined, toolHeaders(strangerSession.id)),
      strangerDelete.res,
      ctx,
    );
    expect(strangerDelete.status).toBe(403);

    // The author (same employee identity, any of their sessions) may edit.
    const authorSession2 = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-author-2", employee: "platform-worker" });
    const authorEdit = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "refined" }, toolHeaders(authorSession2.id)),
      authorEdit.res,
      ctx,
    );
    expect(authorEdit.status).toBe(200);
    expect(authorEdit.body.comment.body).toBe("refined");
    expect(authorEdit.body.comment.editedAt).not.toBeNull();

    // The operator may delete any comment; the tombstone keeps the row.
    const operatorDelete = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${comment.id}`, undefined, operatorHeaders),
      operatorDelete.res,
      ctx,
    );
    expect(operatorDelete.status).toBe(200);
    expect(operatorDelete.body.comment.body).toBe("");
    expect(operatorDelete.body.comment.deletedAt).not.toBeNull();

    // Editing a tombstone is refused.
    const editDeleted = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${comment.id}`, { body: "resurrect" }, operatorHeaders),
      editDeleted.res,
      ctx,
    );
    expect(editDeleted.status).toBe(409);

    // Unknown comment id → 404.
    const missing = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/wic_000000000000`, { body: "?" }, operatorHeaders),
      missing.res,
      ctx,
    );
    expect(missing.status).toBe(404);
  });
});

describe("comment writes emit company:changed for the parent Todo", () => {
  it("POST, PATCH, and DELETE each emit one entity=todo event", async () => {
    const item = store.createWorkItem({ title: "live comment item" });

    emittedEvents.length = 0;
    const posted = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "hello" }, operatorHeaders),
      posted.res,
      ctx,
    );
    expect(posted.status).toBe(201);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "commented", id: item.id }),
    }));

    const commentId = posted.body.comment.id;
    emittedEvents.length = 0;
    const edited = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}/comments/${commentId}`, { body: "hello again" }, operatorHeaders),
      edited.res,
      ctx,
    );
    expect(edited.status).toBe(200);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "comment-edited", id: item.id }),
    }));

    emittedEvents.length = 0;
    const removed = makeRes();
    await api.handleApiRequest(
      makeReq("DELETE", `/api/work-items/${item.id}/comments/${commentId}`, undefined, operatorHeaders),
      removed.res,
      ctx,
    );
    expect(removed.status).toBe(200);
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      event: "company:changed",
      payload: expect.objectContaining({ entity: "todo", action: "comment-deleted", id: item.id }),
    }));
  });

  it("a refused comment write emits nothing", async () => {
    const item = store.createWorkItem({ title: "no event on refusal" });
    emittedEvents.length = 0;
    const refused = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "   " }, operatorHeaders),
      refused.res,
      ctx,
    );
    expect(refused.status).toBe(400);
    expect(emittedEvents).toEqual([]);
  });
});
