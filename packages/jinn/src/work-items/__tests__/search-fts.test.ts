import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-search-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type CommentAdd = typeof import("../comment-add.js");
type Comments = typeof import("../comments.js");
type Labels = typeof import("../labels.js");
let store: Store;
let commentAdd: CommentAdd;
let comments: Comments;
let labels: Labels;
let db: import("better-sqlite3").Database;

/** The Todo the whole search category is about. */
let redesign: import("../store.js").WorkItem;
/** Matches only through a comment body — nothing in its own title or body. */
let commented: import("../store.js").WorkItem;
let commentedId: string;
/** Mentions `redesign`'s id in its body, so an id query has a text rival. */
let mentions: import("../store.js").WorkItem;

const OPERATOR = { author: "operator", authorKind: "operator" as const, operator: true };

beforeAll(async () => {
  store = await import("../store.js");
  commentAdd = await import("../comment-add.js");
  comments = await import("../comments.js");
  labels = await import("../labels.js");
  db = (await import("../../shared/db.js")).initDb();

  redesign = store.createWorkItem({
    title: "Redesign Todos Search & Cmd + K global search",
    body: "Typing a query opens a preview pane beside the result list.",
  });
  commented = store.createWorkItem({ title: "Quarterly ledger chore", body: "Routine reconciliation." });
  commentedId = commentAdd.addComment({
    workItemId: commented.id,
    body: "The marmalade cascade needs a rethink before we ship.",
    ...OPERATOR,
  }).id;
  mentions = store.createWorkItem({
    title: "Wave 2 follow-up",
    body: `Blocked on ${redesign.id} until the index lands.`,
  });
});

describe("free-text Todo search", () => {
  it("matches words that span title and body, in any order", () => {
    // "search" lives in the title, "opens" in the body.
    expect(store.queryWorkItems({ text: "search opens" }).workItems.map((i) => i.id)).toContain(redesign.id);
    // Two body words, given back to front.
    expect(store.queryWorkItems({ text: "pane preview" }).workItems.map((i) => i.id)).toContain(redesign.id);
  });

  it("returns a Todo whose only match is inside a comment, and says which comment", () => {
    const page = store.queryWorkItems({ text: "marmalade" });
    expect(page.workItems.map((i) => i.id)).toEqual([commented.id]);
    const reasons = page.matches?.[commented.id] ?? [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0].field).toBe("comment");
    expect(reasons[0].commentId).toBe(commentedId);
    expect(reasons[0].snippet).toContain("<mark>marmalade</mark>");
  });

  it("puts an exact Todo id ahead of every text hit", () => {
    const page = store.queryWorkItems({ text: redesign.id });
    expect(page.workItems.map((i) => i.id)).toContain(mentions.id); // the text rival is still there
    expect(page.workItems[0].id).toBe(redesign.id);
    expect(page.matches?.[redesign.id]?.[0].field).toBe("id");
  });

  it("orders by relevance when text is given, and leaves the stored order alone when it is not", () => {
    const titleHit = store.createWorkItem({ title: "Snorkel inventory", body: "Nothing else here." });
    const bodyHit = store.createWorkItem({ title: "Dive log", body: "One snorkel per diver, please." });
    // bodyHit is newer, so the stored order would lead with it.
    const ranked = store.queryWorkItems({ text: "snorkel" }).workItems.map((i) => i.id);
    expect(ranked.slice(0, 2)).toEqual([titleHit.id, bodyHit.id]);

    const untouched = store.queryWorkItems({ limit: 100 });
    const baseOrder = db
      .prepare(
        `SELECT id FROM work_items
         ORDER BY (rank IS NULL) ASC, rank ASC, updated_at DESC, created_at DESC, id ASC LIMIT 100`,
      )
      .pluck()
      .all() as string[];
    expect(untouched.workItems.map((i) => i.id)).toEqual(baseOrder);
    expect("matches" in untouched).toBe(false);
  });

  it("survives text FTS5 would otherwise choke on", () => {
    for (const text of ['"', "*", "NEAR(a b)", "-foo", "''", "()", "a AND", "   "]) {
      const page = store.queryWorkItems({ text });
      expect(Array.isArray(page.workItems)).toBe(true);
      expect(page.total).toBe(page.workItems.length);
    }
  });
});

describe("free-text search composed with the other filters", () => {
  let parent: import("../store.js").WorkItem;
  let child: import("../store.js").WorkItem;

  beforeAll(() => {
    parent = store.createWorkItem({ title: "Barnacle programme", body: "Umbrella for the barnacle work." });
    child = store.createWorkItem({
      title: "Barnacle scraping",
      body: "Scrape the barnacle off the hull.",
      parentId: parent.id,
      assignee: "a-lead",
      status: "executing",
    });
    labels.createLabel({ name: "hull" });
    labels.addWorkItemLabels(child.id, ["hull"], "operator");
  });

  const expectTotalsAgree = (page: import("../store.js").WorkItemPage): void => {
    expect(page.total).toBe(page.workItems.length);
    const counted: Record<string, number> = {};
    for (const item of page.workItems) counted[item.status] = (counted[item.status] ?? 0) + 1;
    for (const [status, total] of Object.entries(page.totals)) expect(total).toBe(counted[status] ?? 0);
  };

  it("intersects with status, assignee, label, parentId and rootsOnly", () => {
    for (const filter of [
      { text: "barnacle", status: "executing" as const },
      { text: "barnacle", assignee: "a-lead" },
      { text: "barnacle", label: "hull" },
      { text: "barnacle", parentId: parent.id },
    ]) {
      const page = store.queryWorkItems({ ...filter, limit: 100 });
      expect(page.workItems.map((i) => i.id)).toEqual([child.id]);
      expectTotalsAgree(page);
    }

    const roots = store.queryWorkItems({ text: "barnacle", rootsOnly: true, limit: 100 });
    expect(roots.workItems.map((i) => i.id)).toEqual([parent.id]);
    expectTotalsAgree(roots);
  });
});

describe("index currency", () => {
  it("follows Todo creates and title/body edits", () => {
    const item = store.createWorkItem({ title: "Zephyr protocol", body: "Original wording." });
    expect(store.queryWorkItems({ text: "zephyr" }).workItems.map((i) => i.id)).toEqual([item.id]);

    store.updateWorkItem(item.id, { title: "Mistral protocol", body: "Rewritten wording." });
    expect(store.queryWorkItems({ text: "zephyr" }).workItems).toEqual([]);
    expect(store.queryWorkItems({ text: "original" }).workItems).toEqual([]);
    expect(store.queryWorkItems({ text: "mistral" }).workItems.map((i) => i.id)).toEqual([item.id]);
    expect(store.queryWorkItems({ text: "rewritten" }).workItems.map((i) => i.id)).toEqual([item.id]);
  });

  it("follows comment add, edit and tombstone", () => {
    const item = store.createWorkItem({ title: "Kelp survey" });
    const comment = commentAdd.addComment({ workItemId: item.id, body: "Sighted a nudibranch.", ...OPERATOR });
    expect(store.queryWorkItems({ text: "nudibranch" }).workItems.map((i) => i.id)).toEqual([item.id]);

    comments.editComment(comment.id, "Sighted a cuttlefish instead.", OPERATOR);
    expect(store.queryWorkItems({ text: "nudibranch" }).workItems).toEqual([]);
    expect(store.queryWorkItems({ text: "cuttlefish" }).workItems.map((i) => i.id)).toEqual([item.id]);

    comments.tombstoneComment(comment.id, OPERATOR);
    expect(store.queryWorkItems({ text: "cuttlefish" }).workItems).toEqual([]);
  });

  // The claim above is that the SQL triggers — not any JS call site — keep the
  // index current. Drop one and the same edit must go unnoticed; that is what
  // makes the passing tests above evidence rather than assertion.
  it("goes stale exactly when its trigger is missing", () => {
    const item = store.createWorkItem({ title: "Halyard audit" });
    const comment = commentAdd.addComment({ workItemId: item.id, body: "Frayed at the sheave.", ...OPERATOR });
    db.exec("DROP TRIGGER work_item_comments_fts_au");
    try {
      comments.tombstoneComment(comment.id, OPERATOR);
      expect(store.queryWorkItems({ text: "sheave" }).workItems.map((i) => i.id)).toEqual([item.id]);
    } finally {
      db.exec(`CREATE TRIGGER work_item_comments_fts_au AFTER UPDATE ON work_item_comments BEGIN
  INSERT INTO work_item_comments_fts(work_item_comments_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO work_item_comments_fts(rowid, body) VALUES (new.rowid, new.body);
END`);
      db.exec("INSERT INTO work_item_comments_fts(work_item_comments_fts) VALUES ('rebuild')");
    }
    expect(store.queryWorkItems({ text: "sheave" }).workItems).toEqual([]);
  });
});

describe("response shape", () => {
  it("adds `matches` only when text was given", () => {
    expect("matches" in store.queryWorkItems({ status: "backlog" })).toBe(false);
    expect("matches" in store.queryWorkItems({ text: "marmalade" })).toBe(true);
  });

  it("still hands searchWorkItems a plain Todo array", () => {
    const found = store.searchWorkItems({ text: "marmalade" });
    expect(found.map((i) => i.id)).toEqual([commented.id]);
    expect(found[0]).not.toHaveProperty("matches");
  });
});

describe("free-text search is not truncated before the other filters run", () => {
  // More hits than the candidate ceiling this used to carry: a Todo that fell
  // outside the head of the match set was invisible to every structured filter
  // composed with it, and `total` reported the ceiling rather than the truth.
  const BULK = 520;
  const TOKEN = "sporangium";

  beforeAll(() => {
    for (let n = 0; n < BULK; n += 1) {
      store.createWorkItem({ title: `Bulk ${n}`, body: `A ${TOKEN} entry.`, assignee: "bulk-owner" });
    }
  });

  it("counts and composes over the whole match set", () => {
    expect(store.queryWorkItems({ text: TOKEN, limit: 1 }).total).toBe(BULK);
    const composed = store.queryWorkItems({ text: TOKEN, assignee: "bulk-owner", limit: 1 });
    expect(composed.total).toBe(BULK);
    expect(composed.totals.backlog).toBe(BULK);
    expect(composed.workItems).toHaveLength(1);
  });
});
