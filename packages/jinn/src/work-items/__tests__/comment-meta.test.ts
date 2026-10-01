import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "better-sqlite3";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-comment-meta-"));
process.env.JINN_HOME = home;

let store: typeof import("../store.js");
let comments: typeof import("../comments.js");
let db: Database;

beforeAll(async () => {
  store = await import("../store.js");
  comments = await import("../comments.js");
  db = (await import("../../shared/db.js")).initDb();
});

const META_TABLE = "work_item_comment_meta";

function metaTableExists(): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(META_TABLE));
}

function add(workItemId: string, body: string, extra: Partial<Parameters<typeof comments.addComment>[0]> = {}) {
  return comments.addComment({ workItemId, body, author: "operator", authorKind: "operator", ...extra });
}

// Runs first on purpose: the meta table is created lazily, and this is the only
// test that can still see a database from before it existed.
describe("a database that predates comment meta", () => {
  it("lists its old comments unchanged, and only creates the table when it is first read", () => {
    const item = store.createWorkItem({ title: "legacy comments" });
    db.prepare(
      `INSERT INTO work_item_comments (id, work_item_id, parent_comment_id, author_kind, author, body, created_at, edited_at, deleted_at)
       VALUES ('wic_0123456789ab', ?, NULL, 'operator', 'operator', 'written before meta existed', '2026-01-01T00:00:00.000Z', NULL, NULL)`,
    ).run(item.id);
    expect(metaTableExists()).toBe(false);

    const listed = comments.listComments(item.id).comments;
    expect(listed).toEqual([
      {
        id: "wic_0123456789ab",
        workItemId: item.id,
        parentCommentId: null,
        authorKind: "operator",
        author: "operator",
        body: "written before meta existed",
        createdAt: "2026-01-01T00:00:00.000Z",
        editedAt: null,
        deletedAt: null,
      },
    ]);
    expect(metaTableExists()).toBe(true);
  });
});

describe("a comment's session", () => {
  it("comes back from add, listComments and commentsTail", () => {
    const item = store.createWorkItem({ title: "session stamped" });
    const added = add(item.id, "from a session", { sessionId: "sess-abc" });
    expect(added.sessionId).toBe("sess-abc");
    expect(comments.listComments(item.id).comments[0]).toMatchObject({ id: added.id, sessionId: "sess-abc" });
    expect(comments.commentsTail(item.id).comments[0]).toMatchObject({ id: added.id, sessionId: "sess-abc" });
  });

  it("survives a single read, an edit and a tombstone", () => {
    const item = store.createWorkItem({ title: "edited later" });
    const added = add(item.id, "first draft", { sessionId: "sess-edit" });
    const editor = { author: "operator", authorKind: "operator" as const, operator: true };
    expect(comments.getComment(added.id)?.sessionId).toBe("sess-edit");
    expect(comments.editComment(added.id, "second draft", editor).sessionId).toBe("sess-edit");
    expect(comments.tombstoneComment(added.id, editor).sessionId).toBe("sess-edit");
  });

  it("is absent, not null, on a comment written without one", () => {
    const item = store.createWorkItem({ title: "no session" });
    const added = add(item.id, "operator note");
    for (const comment of [added, comments.listComments(item.id).comments[0], comments.commentsTail(item.id).comments[0]]) {
      expect(comment).not.toHaveProperty("sessionId");
      expect(comment).not.toHaveProperty("repliedToId");
    }
  });

  it("keeps a session-less comment's shape when its neighbour has meta", () => {
    const item = store.createWorkItem({ title: "mixed" });
    const plain = add(item.id, "plain");
    add(item.id, "stamped", { sessionId: "sess-mixed" });
    const [first, second] = comments.listComments(item.id).comments;
    expect(first.id).toBe(plain.id);
    expect(Object.keys(first)).not.toContain("sessionId");
    expect(second.sessionId).toBe("sess-mixed");
  });
});

describe("a reply's target", () => {
  it("is the root for a reply to a root", () => {
    const item = store.createWorkItem({ title: "reply to root" });
    const root = add(item.id, "root");
    const reply = add(item.id, "reply", { parentCommentId: root.id });
    expect(reply).toMatchObject({ parentCommentId: root.id, repliedToId: root.id });
    expect(comments.listComments(item.id).comments.find((c) => c.id === reply.id)).toMatchObject({ repliedToId: root.id });
  });

  it("survives flattening: a reply to a reply hangs off the root but remembers who it answered", () => {
    const item = store.createWorkItem({ title: "reply to reply" });
    const root = add(item.id, "root");
    const first = add(item.id, "first reply", { parentCommentId: root.id });
    const nested = add(item.id, "answer to the first reply", { parentCommentId: first.id });

    expect(nested.parentCommentId).toBe(root.id);
    expect(nested.repliedToId).toBe(first.id);
    const stored = comments.listComments(item.id).comments.find((c) => c.id === nested.id)!;
    expect(stored).toMatchObject({ parentCommentId: root.id, repliedToId: first.id });
    expect(root).not.toHaveProperty("repliedToId");
  });

  it("is recorded together with the session, in one row", () => {
    const item = store.createWorkItem({ title: "reply with session" });
    const root = add(item.id, "root");
    const reply = add(item.id, "reply", { parentCommentId: root.id, sessionId: "sess-reply" });
    expect(comments.commentsTail(item.id).comments.find((c) => c.id === reply.id)).toMatchObject({
      sessionId: "sess-reply",
      repliedToId: root.id,
    });
  });
});

describe("idempotent replay", () => {
  it("returns the original comment with its meta and writes one meta row", () => {
    const item = store.createWorkItem({ title: "replayed with meta" });
    const input = { sessionId: "sess-replay", idempotencyKey: "meta-replay-1" };
    const first = add(item.id, "once", input);
    const replay = add(item.id, "once", input);

    expect(replay).toEqual(first);
    expect(replay.sessionId).toBe("sess-replay");
    expect(comments.listComments(item.id).comments).toHaveLength(1);
    const rows = db.prepare(`SELECT * FROM ${META_TABLE} WHERE comment_id = ?`).all(first.id);
    expect(rows).toHaveLength(1);
  });
});

describe("meta row lifetime", () => {
  it("goes with its comment (foreign keys cascade)", () => {
    const item = store.createWorkItem({ title: "cascade" });
    const added = add(item.id, "doomed", { sessionId: "sess-doomed" });
    expect(db.prepare(`SELECT COUNT(*) FROM ${META_TABLE} WHERE comment_id = ?`).pluck().get(added.id)).toBe(1);
    db.prepare("DELETE FROM work_item_comments WHERE id = ?").run(added.id);
    expect(db.prepare(`SELECT COUNT(*) FROM ${META_TABLE} WHERE comment_id = ?`).pluck().get(added.id)).toBe(0);
  });
});
