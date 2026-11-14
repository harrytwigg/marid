import { describe, it, expect } from "vitest";
import { api, ctx, makeRawReq, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

describe("Todos v2 slice 2 — comment reads and writes", () => {
  it("POST stamps author/authorKind server-side for operator, employee-session, and bare-session callers", async () => {
    const item = store.createWorkItem({ title: "comment stamp item" });

    const operator = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "operator says" }, operatorHeaders),
      operator.res,
      ctx,
    );
    expect(operator.status).toBe(201);
    expect(operator.body.comment).toMatchObject({
      workItemId: item.id,
      parentCommentId: null,
      author: "operator",
      authorKind: "operator",
      body: "operator says",
    });

    const employeeSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-emp", employee: "platform-worker" });
    const employee = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "employee says" }, toolHeaders(employeeSession.id)),
      employee.res,
      ctx,
    );
    expect(employee.status).toBe(201);
    expect(employee.body.comment).toMatchObject({ author: "platform-worker", authorKind: "employee" });

    const bareSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "comment-bare" });
    const bare = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "bare session says" }, toolHeaders(bareSession.id)),
      bare.res,
      ctx,
    );
    expect(bare.status).toBe(201);
    expect(bare.body.comment).toMatchObject({ author: `session:${bareSession.id}`, authorKind: "employee" });
  });

  it("POST rejects body-supplied author fields and unauthenticated callers", async () => {
    const item = store.createWorkItem({ title: "comment reject item" });

    for (const bad of [{ body: "x", author: "operator" }, { body: "x", authorKind: "operator" }]) {
      const res = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, bad, operatorHeaders), res.res, ctx);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/author/i);
    }

    const anonymous = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "anon" }), anonymous.res, ctx);
    expect(anonymous.status).toBe(403);

    const missingBody = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "   " }, operatorHeaders), missingBody.res, ctx);
    expect(missingBody.status).toBe(400);
    expect(missingBody.body.error).toMatch(/body/i);
  });

  it("POST enforces the 64 KiB byte cap with 413", async () => {
    const item = store.createWorkItem({ title: "comment cap item" });
    const raw = `{"body":"${"a".repeat(64 * 1024)}"}`;
    const res = makeRes();
    await api.handleApiRequest(
      makeRawReq("POST", `/api/work-items/${item.id}/comments`, raw, operatorHeaders),
      res.res,
      ctx,
    );
    expect(res.status).toBe(413);
  });

  it("POST threads single-level: replying to a reply re-parents to the thread root; 404s on unknown todo/parent", async () => {
    const item = store.createWorkItem({ title: "comment thread item" });
    const rootRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "thread root" }, operatorHeaders),
      rootRes.res,
      ctx,
    );
    const root = rootRes.body.comment;

    const replyRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "reply", parentCommentId: root.id }, operatorHeaders),
      replyRes.res,
      ctx,
    );
    expect(replyRes.status).toBe(201);
    expect(replyRes.body.comment.parentCommentId).toBe(root.id);

    const deepRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "deep", parentCommentId: replyRes.body.comment.id }, operatorHeaders),
      deepRes.res,
      ctx,
    );
    expect(deepRes.status).toBe(201);
    expect(deepRes.body.comment.parentCommentId).toBe(root.id);

    const missingTodo = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items/ZZZ-424242/comments", { body: "?" }, operatorHeaders), missingTodo.res, ctx);
    expect(missingTodo.status).toBe(404);

    const missingParent = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "?", parentCommentId: "wic_000000000000" }, operatorHeaders),
      missingParent.res,
      ctx,
    );
    expect(missingParent.status).toBe(404);
  });

  it("GET lists chronologically with limit/offset and 404s on an unknown todo (no :id collision)", async () => {
    const item = store.createWorkItem({ title: "comment list item" });
    for (let i = 1; i <= 3; i++) {
      const res = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: `c${i}` }, operatorHeaders), res.res, ctx);
      expect(res.status).toBe(201);
    }

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}/comments`), list.res, ctx);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    expect(list.body.comments.map((c: { body: string }) => c.body)).toEqual(["c1", "c2", "c3"]);
    expect(list.body).toHaveProperty("limit");
    expect(list.body).toHaveProperty("offset");

    const page = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}/comments?limit=1&offset=1`), page.res, ctx);
    expect(page.status).toBe(200);
    expect(page.body.comments.map((c: { body: string }) => c.body)).toEqual(["c2"]);
    expect(page.body.total).toBe(3);

    const missing = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ZZZ-424242/comments"), missing.res, ctx);
    expect(missing.status).toBe(404);
  });

  it("the Todo detail payload carries the comments tail additively", async () => {
    const item = store.createWorkItem({ title: "comment tail item" });
    const posted = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${item.id}/comments`, { body: "tail me" }, operatorHeaders), posted.res, ctx);
    expect(posted.status).toBe(201);

    const detail = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), detail.res, ctx);
    expect(detail.status).toBe(200);
    expect(detail.body.workItem.id).toBe(item.id);
    expect(detail.body).toHaveProperty("spendUsd");
    expect(detail.body).toHaveProperty("events");
    expect(detail.body.comments.total).toBe(1);
    expect(detail.body.comments.comments[0].body).toBe("tail me");
  });
});
