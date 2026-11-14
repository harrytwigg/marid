import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBoardHarness, type BoardHarness, type Member } from "./board-harness.js";

let h: BoardHarness;
let viewer: Member;
let collab: Member;
let other: Member;
let store: typeof import("../../work-items/store.js");
let labels: typeof import("../../work-items/labels.js");
let comments: typeof import("../../work-items/comments.js");
let autoStart: typeof import("../../work-items/auto-start.js");
let operatorRoot: string;

const row = (id: string) => h.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as any;
const create = async (m: Member, body: Record<string, unknown>) => h.as(m, "POST", "/api/member/boards/ops/todos", body);

beforeAll(async () => {
  h = await startBoardHarness();
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  comments = await import("../../work-items/comments.js");
  autoStart = await import("../../work-items/auto-start.js");
  viewer = await h.join("viewer@example.test", "viewer");
  collab = await h.join("collab@example.test", "collaborator", "ops", "Casey Collab");
  other = await h.join("other@example.test", "collaborator", "ops", "Olly Other");
  operatorRoot = store.createWorkItem({ title: "Operator's Todo", department: "ops" }).id;
  labels.createLabel({ name: "urgent" });
}, 60_000);
afterAll(async () => { await h.close(); });

describe("roles", () => {
  it("a viewer reads and writes nothing", async () => {
    const mine = (await create(collab, { title: "T" })).body.workItem;
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/api/member/boards/ops/todos", { title: "x" }],
      ["PATCH", `/api/member/todos/${mine.id}`, { title: "y", expectedVersion: mine.version }],
      ["POST", `/api/member/todos/${mine.id}/status`, { status: "done" }],
      ["POST", `/api/member/todos/${mine.id}/comments`, { body: "hi" }],
    ];
    for (const [method, url, body] of writes) {
      const reply = await h.as(viewer, method, url, body);
      expect([url, reply.status]).toEqual([url, 403]);
    }
    expect((await h.as(viewer, "GET", `/api/member/todos/${mine.id}`)).status).toBe(200);
  });

  it("a collaborator comments on any Todo on the board, but edits only a member-only tree", async () => {
    const comment = await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "hello" });
    expect(comment.status).toBe(201);
    const patch = await h.as(collab, "PATCH", `/api/member/todos/${operatorRoot}`, { title: "mine now", expectedVersion: store.getWorkItem(operatorRoot)!.version });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe("todo_not_member_editable");
    expect((await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/status`, { status: "done" })).status).toBe(403);
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "sub", parentId: operatorRoot })).status).toBe(403);
    expect(store.getWorkItem(operatorRoot)!.title).toBe("Operator's Todo");
  });
});

describe("a member's create is stored so that every reader that does not know about members grants nothing", () => {
  it("source connector, user: ref and creator, an unassigned Todo whose dispatch row says never auto-start", async () => {
    const reply = await create(collab, { title: "  Fix the thing  ", body: "why", priority: 1, labels: ["urgent"] });
    expect(reply.status).toBe(201);
    const id = reply.body.workItem.id;
    const stored = row(id);
    expect(stored).toMatchObject({ source: "connector", created_by: `user:${collab.userId}`, assignee: null, title: "Fix the thing", priority: 1, department: "ops" });
    expect(stored.source_ref).toMatch(new RegExp(`^user:${collab.userId}:[0-9a-f]{12}$`));
    expect(reply.body.workItem.sourceRef).toBeNull();
    expect(autoStart.readAutoStartRow(h.db, id)).toMatchObject({ auto_start: 0 });
    expect(labels.getWorkItemLabels(id).map((label) => label.name)).toEqual(["urgent"]);
    const created = h.db.prepare("SELECT actor FROM work_item_events WHERE work_item_id = ? AND kind = 'created'").get(id) as { actor: string };
    expect(created.actor).toBe("connector");
  });

  it("is attributed by the server: the body cannot name another creator, source or assignee", async () => {
    for (const field of ["createdBy", "source", "sourceRef", "assignee", "department", "status", "autoStart", "dueAt", "sprint"]) {
      const reply = await create(collab, { title: "x", [field]: field === "autoStart" ? true : "operator" });
      expect([field, reply.status]).toEqual([field, 403]);
    }
    expect((await create(collab, { title: "x", surprise: 1 })).status).toBe(400);
    expect((await create(collab, { title: "" })).status).toBe(400);
    expect((await create(collab, { title: "x", priority: 9 })).status).toBe(400);
    expect((await create(collab, { title: "x", labels: ["no-such-label"] })).status).toBe(400);
    // The failed create left nothing behind: a refused label rolled the whole create back.
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE title = 'x'").get()).toEqual({ n: 0 });
  });

  it("an idempotency key replays the same Todo, and another member's identical key does not", async () => {
    const first = await create(collab, { title: "once", idempotencyKey: "k1" });
    const again = await create(collab, { title: "once", idempotencyKey: "k1" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, workItem: { id: first.body.workItem.id } });
    const theirs = await create(other, { title: "once", idempotencyKey: "k1" });
    expect(theirs.status).toBe(201);
    expect(theirs.body.workItem.id).not.toBe(first.body.workItem.id);
    expect((await create(collab, { title: "different", idempotencyKey: "k1" })).status).toBe(409);
  });

  it("creating a sub-task: in a member-only tree only, on the board the route names", async () => {
    const root = (await create(collab, { title: "root" })).body.workItem;
    const sub = await h.as(other, "POST", "/api/member/boards/ops/todos", { title: "sub", parentId: root.id });
    expect(sub.status).toBe(201);
    expect(row(sub.body.workItem.id)).toMatchObject({ parent_id: root.id, root_id: root.id, created_by: `user:${other.userId}`, source: "connector" });
    expect(autoStart.readAutoStartRow(h.db, sub.body.workItem.id)).toMatchObject({ auto_start: 0 });
    // A parent on another board, or one that is not there, is a 404.
    const designRoot = store.createWorkItem({ title: "d", department: "design" }).id;
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "s", parentId: designRoot })).status).toBe(404);
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "s", parentId: "OPS-999999" })).status).toBe(404);
  });
});

describe("member-only trees", () => {
  it("the whole tree is checked at each write: one operator-created sub-task, an assignee or a linked session ends it", async () => {
    const root = (await create(collab, { title: "tree" })).body.workItem;
    const sub = (await create(collab, { title: "kid", parentId: root.id })).body.workItem;
    const edit = (id: string) => h.as(collab, "PATCH", `/api/member/todos/${id}`, { title: `edit ${Math.random()}`, expectedVersion: store.getWorkItem(id)!.version });
    expect((await edit(root.id)).status).toBe(200);
    expect((await edit(sub.id)).status).toBe(200);

    // The operator hangs a Todo of their own under it: nothing in the tree is editable any more, the root included.
    const mixed = store.createWorkItem({ title: "operator's", parentId: sub.id }).id;
    expect((await edit(root.id)).status).toBe(403);
    expect((await edit(sub.id)).status).toBe(403);
    expect((await h.as(collab, "POST", "/api/member/boards/ops/todos", { title: "more", parentId: root.id })).status).toBe(403);
    expect((await h.as(collab, "POST", `/api/member/todos/${root.id}/comments`, { body: "still can comment" })).status).toBe(201);
    h.db.prepare("DELETE FROM work_items WHERE id = ?").run(mixed);
    expect((await edit(root.id)).status).toBe(200);

    // An assignee on the child, even one that lands later.
    h.db.prepare("UPDATE work_items SET assignee = 'alice' WHERE id = ?").run(sub.id);
    expect((await edit(root.id)).status).toBe(403);
    h.db.prepare("UPDATE work_items SET assignee = NULL WHERE id = ?").run(sub.id);
    expect((await edit(root.id)).status).toBe(200);

    // A linked session.
    const sessions = await import("../../sessions/registry.js");
    const session = sessions.createSession({ engine: "claude", source: "web", sourceRef: "t", employee: "alice" } as any);
    store.linkSession(sub.id, session.id, "operator");
    expect((await edit(sub.id)).status).toBe(403);
    h.db.prepare("UPDATE sessions SET work_item_id = NULL WHERE id = ?").run(session.id);
    expect((await edit(sub.id)).status).toBe(200);
  });

  it("a Todo the operator created is never member-only, whatever its status", async () => {
    expect((await h.as(collab, "PATCH", `/api/member/todos/${operatorRoot}`, { title: "x", expectedVersion: 1 })).status).toBe(403);
  });
});

describe("PATCH", () => {
  it("edits title, body, priority and labels and answers { workItem, replayed }", async () => {
    const t = (await create(collab, { title: "edit me" })).body.workItem;
    const reply = await h.as(other, "PATCH", `/api/member/todos/${t.id}`, { title: "edited", body: "b", priority: 0, labels: ["urgent"], expectedVersion: t.version });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.body).sort()).toEqual(["replayed", "workItem"]);
    expect(reply.body).toMatchObject({ replayed: false, workItem: { title: "edited", body: "b", priority: 0 } });
    expect(labels.getWorkItemLabels(t.id).map((label) => label.name)).toEqual(["urgent"]);
    const event = h.db.prepare("SELECT actor FROM work_item_events WHERE work_item_id = ? AND kind = 'metadata_edited'").get(t.id) as { actor: string };
    expect(event.actor).toBe(`user:${other.userId}`);
  });

  it("requires a version for a content edit, rejects a stale one, and replays an idempotent one", async () => {
    const t = (await create(collab, { title: "versions" })).body.workItem;
    expect((await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { title: "x" })).status).toBe(428);
    const first = await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { title: "one", expectedVersion: t.version, idempotencyKey: "e1" });
    expect(first.status).toBe(200);
    const stale = await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { title: "two", expectedVersion: t.version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("todo_version_conflict");
    const replay = await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { title: "one", expectedVersion: t.version, idempotencyKey: "e1" });
    expect(replay.body.replayed).toBe(true);
  });

  it("a labels-only call needs no version, as the operator's labels route does", async () => {
    const t = (await create(collab, { title: "labels" })).body.workItem;
    const reply = await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { labels: ["urgent"] });
    expect(reply.status).toBe(200);
    expect(labels.getWorkItemLabels(t.id)).toHaveLength(1);
    expect((await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { labels: [] })).status).toBe(200);
    expect(labels.getWorkItemLabels(t.id)).toHaveLength(0);
  });

  it("refuses everything that is the operator's: assignment, department, status, dates, rank", async () => {
    const t = (await create(collab, { title: "guarded" })).body.workItem;
    for (const field of ["assignee", "department", "status", "dueAt", "startAt", "rank"]) {
      const reply = await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { [field]: "x", expectedVersion: t.version });
      expect([field, reply.status]).toEqual([field, 403]);
    }
    expect((await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { nonsense: 1, expectedVersion: t.version })).status).toBe(400);
    expect((await h.as(collab, "PATCH", `/api/member/todos/${t.id}`, { expectedVersion: t.version })).status).toBe(400);
    expect(row(t.id)).toMatchObject({ assignee: null, department: "ops", status: "backlog" });
  });
});

describe("status", () => {
  it("backlog → done and done → backlog, nothing else", async () => {
    const t = (await create(collab, { title: "close me" })).body.workItem;
    const closed = await h.as(other, "POST", `/api/member/todos/${t.id}/status`, { status: "done" });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ escalated: false, workItem: { status: "done" } });
    expect(Object.keys(closed.body).sort()).toEqual(["escalated", "workItem"]);
    const event = h.db.prepare("SELECT actor, to_status FROM work_item_events WHERE work_item_id = ? AND kind = 'status_change'").get(t.id) as any;
    expect(event).toEqual({ actor: `user:${other.userId}`, to_status: "done" });
    const reopened = await h.as(other, "POST", `/api/member/todos/${t.id}/status`, { status: "backlog" });
    expect(reopened.body.workItem.status).toBe("backlog");
    for (const status of ["executing", "in_review", "blocked", "cancelled", "bogus"]) {
      expect([status, (await h.as(other, "POST", `/api/member/todos/${t.id}/status`, { status })).status]).toEqual([status, 400]);
    }
    for (const extra of ["cascade", "manual", "bounce", "human", "note"]) {
      expect([extra, (await h.as(other, "POST", `/api/member/todos/${t.id}/status`, { status: "done", [extra]: true })).status]).toEqual([extra, 400]);
    }
  });

  it("another status the Todo is in is not a member's to move: an executing Todo stays put", async () => {
    const t = (await create(collab, { title: "operator started it" })).body.workItem;
    h.db.prepare("UPDATE work_items SET status = 'executing' WHERE id = ?").run(t.id);
    const reply = await h.as(collab, "POST", `/api/member/todos/${t.id}/status`, { status: "done" });
    expect(reply.status).toBe(409);
    expect(row(t.id).status).toBe("executing");
  });

  it("is refused while the Todo has open children: members get no cascade", async () => {
    const root = (await create(collab, { title: "parent" })).body.workItem;
    const kid = (await create(collab, { title: "kid", parentId: root.id })).body.workItem;
    const refused = await h.as(collab, "POST", `/api/member/todos/${root.id}/status`, { status: "done" });
    expect(refused.status).toBe(409);
    expect(row(root.id).status).toBe("backlog");
    expect((await h.as(collab, "POST", `/api/member/todos/${kid.id}/status`, { status: "done" })).status).toBe(200);
    expect((await h.as(collab, "POST", `/api/member/todos/${root.id}/status`, { status: "done" })).status).toBe(200);
  });

  it("closing a child writes no child-settle row, so no parent wake is queued", async () => {
    const root = (await create(collab, { title: "parent" })).body.workItem;
    const kid = (await create(collab, { title: "kid", parentId: root.id })).body.workItem;
    await h.as(collab, "POST", `/api/member/todos/${kid.id}/status`, { status: "done" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_item_child_settles WHERE child_id = ?").get(kid.id)).toEqual({ n: 0 });
    // The control: the same close by the operator does queue one.
    const control = store.createWorkItem({ title: "c", parentId: store.createWorkItem({ title: "p", department: "ops" }).id }).id;
    const transitions = await import("../../work-items/transitions.js");
    transitions.transition(control, "done", "operator", { human: true });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM work_item_child_settles WHERE child_id = ?").get(control)).toEqual({ n: 1 });
  });
});

describe("comments", () => {
  it("are stored as system comments by user:<id>, and the server stamps the author", async () => {
    const reply = await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "from Casey" });
    expect(reply.status).toBe(201);
    expect(Object.keys(reply.body)).toEqual(["comment"]);
    expect(reply.body.comment).toMatchObject({ author: `user:${collab.userId}`, authorKind: "member", body: "from Casey" });
    expect(reply.body.comment).not.toHaveProperty("sessionId");
    const stored = h.db.prepare("SELECT author_kind, author FROM work_item_comments WHERE id = ?").get(reply.body.comment.id) as any;
    expect(stored).toEqual({ author_kind: "system", author: `user:${collab.userId}` });
    expect((await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "x", author: "operator" })).status).toBe(400);
    expect((await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "x", authorKind: "operator" })).status).toBe(400);
    expect((await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "  " })).status).toBe(400);
  });

  it("threads under a parent comment", async () => {
    const parent = (await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "q" })).body.comment;
    const reply = await h.as(other, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "a", parentCommentId: parent.id });
    expect(reply.body.comment.parentCommentId).toBe(parent.id);
    expect((await h.as(other, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "a", parentCommentId: "nope" })).status).toBe(400);
  });

  it("a member edits and deletes their own comment only", async () => {
    const mine = (await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "mine" })).body.comment;
    const edit = await h.as(collab, "PATCH", `/api/member/todos/${operatorRoot}/comments/${mine.id}`, { body: "mine, edited" });
    expect(edit.status).toBe(200);
    expect(edit.body.comment).toMatchObject({ body: "mine, edited", authorKind: "member" });
    expect((await h.as(other, "PATCH", `/api/member/todos/${operatorRoot}/comments/${mine.id}`, { body: "hijack" })).status).toBe(403);
    expect((await h.as(other, "DELETE", `/api/member/todos/${operatorRoot}/comments/${mine.id}`)).status).toBe(403);
    // The operator's comment is not theirs either, even though the operator's author string is "operator".
    const ops = comments.addComment({ workItemId: operatorRoot, body: "op", author: "operator", authorKind: "operator" });
    expect((await h.as(collab, "PATCH", `/api/member/todos/${operatorRoot}/comments/${ops.id}`, { body: "x" })).status).toBe(403);
    // A comment on another Todo is not found under this one.
    const elsewhere = (await create(collab, { title: "else" })).body.workItem;
    expect((await h.as(collab, "PATCH", `/api/member/todos/${elsewhere.id}/comments/${mine.id}`, { body: "x" })).status).toBe(404);
    const removed = await h.as(collab, "DELETE", `/api/member/todos/${operatorRoot}/comments/${mine.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.comment).toMatchObject({ body: "", authorKind: "member" });
  });
});

describe("attachments", () => {
  const upload = (m: Member, id: string, name: string, content: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("file", new Blob([content], { type: "text/plain" }), name);
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return h.request("POST", `/api/member/todos/${id}/attachments`, { cookie: m.cookie, rawBody: form });
  };

  it("a collaborator uploads multipart, to the Todo or to their own comment", async () => {
    const reply = await upload(collab, operatorRoot, "a.txt", "alpha");
    expect(reply.status).toBe(201);
    expect(reply.body.attachment).toMatchObject({ filename: "a.txt", uploadedBy: `user:${collab.userId}`, workItemId: operatorRoot });
    expect(reply.body.attachment).not.toHaveProperty("storagePath");
    const comment = (await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/comments`, { body: "see file" })).body.comment;
    expect((await upload(collab, operatorRoot, "b.txt", "beta", { commentId: comment.id })).status).toBe(201);
    // Not onto someone else's comment.
    expect((await upload(other, operatorRoot, "c.txt", "gamma", { commentId: comment.id })).status).toBe(403);
    const list = await h.as(viewer, "GET", `/api/member/todos/${operatorRoot}/attachments`);
    expect(list.body.attachments.map((a: any) => a.filename).sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("a viewer cannot upload, and the JSON form (a path on the gateway's disk) is never available", async () => {
    expect((await upload(viewer, operatorRoot, "v.txt", "nope")).status).toBe(403);
    const asPath = await h.as(collab, "POST", `/api/member/todos/${operatorRoot}/attachments`, { path: "/etc/hostname" });
    expect(asPath.status).toBe(415);
    expect(asPath.text).not.toMatch(/hostname|localhost/);
  });
});
