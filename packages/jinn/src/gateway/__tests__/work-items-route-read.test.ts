import { describe, it, expect } from "vitest";
import { api, ctx, dbModule, makeReq, makeRes, reg, store } from "./helpers/work-items-route-harness.js";

describe("GET /api/work-items/:id/sessions", () => {
  it("returns the sessions linked to a work item", async () => {
    const s = reg.createSession({ engine: "claude", source: "cron", sourceRef: "cron:routejob:1" });
    const wi = store.createWorkItem({ title: "route item", source: "cron", sourceRef: "cron:routejob:1:wi" });
    store.linkSession(wi.id, s.id);

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}/sessions`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    const ids = (cap.body as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toContain(s.id);
  });

  it("returns an empty array for a work item with no linked sessions", async () => {
    const wi = store.createWorkItem({ title: "lonely item" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}/sessions`), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });

  it("accepts a canonical company-derived route ID before lookup", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items/ICI-999"), cap.res, ctx);
    expect(cap.status).toBe(404);
  });

  it.each(["wi_0123456789ab", "JIN-0", "JIN-01", "JIN-9007199254740992", "garbage"])(
    "rejects malformed Todo route id %s before storage lookup",
    async (id) => {
      for (const suffix of ["", "/sessions"]) {
        const cap = makeRes();
        await api.handleApiRequest(makeReq("GET", `/api/work-items/${id}${suffix}`), cap.res, ctx);
        expect(cap.status).toBe(400);
        expect(cap.body).toEqual({
          error: "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix",
        });
      }
    },
  );
});

describe("GET /api/work-items/:id — the attempt ledger on the detail payload", () => {
  it("returns every run oldest first, with outcome, timestamps, summary and handoff", async () => {
    const runs = await import("../../work-items/runs.js");
    const wi = store.createWorkItem({ title: "attempted twice", source: "delegation" });
    const first = runs.openWorkItemRun({ workItemId: wi.id, sessionId: "s-attempt-1", startedAt: "2026-08-13T10:00:00.000Z" });
    runs.closeWorkItemRun(first.id, {
      outcome: "blocked",
      summary: "the fixture is missing",
      handoff: { changedFiles: ["src/one.ts"], retryNotes: "seed the fixture first" },
      endedAt: "2026-08-13T10:30:00.000Z",
    });
    const second = runs.openWorkItemRun({ workItemId: wi.id, sessionId: "s-attempt-2", startedAt: "2026-08-13T11:00:00.000Z" });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body.runs).toEqual([
      {
        id: first.id,
        workItemId: wi.id,
        sessionId: "s-attempt-1",
        startedAt: "2026-08-13T10:00:00.000Z",
        endedAt: "2026-08-13T10:30:00.000Z",
        outcome: "blocked",
        summary: "the fixture is missing",
        handoff: { changedFiles: ["src/one.ts"], retryNotes: "seed the fixture first" },
        error: null,
      },
      {
        id: second.id,
        workItemId: wi.id,
        sessionId: "s-attempt-2",
        startedAt: "2026-08-13T11:00:00.000Z",
        endedAt: null,
        outcome: null,
        summary: null,
        handoff: {},
        error: null,
      },
    ]);
  });

  it("returns an empty ledger for a Todo nobody has attempted", async () => {
    const wi = store.createWorkItem({ title: "never attempted" });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}`), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body.runs).toEqual([]);
  });
});

describe("GET /api/work-items and /api/search/work-items — pagination, totals, and filters", () => {
  it("returns exact totals plus an offset page beyond the first 20 rows", async () => {
    for (let i = 0; i < 25; i++) {
      store.createWorkItem({
        title: `route page backlog ${i}`,
        status: "backlog",
        department: "route-page-fixture",
        source: "human",
      });
    }
    for (let i = 0; i < 2; i++) {
      store.createWorkItem({
        title: `route page done ${i}`,
        status: "done",
        department: "route-page-fixture",
        source: "human",
      });
    }

    const totals = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?department=route-page-fixture&limit=20"), totals.res, ctx);
    expect(totals.status).toBe(200);
    expect(totals.body).toMatchObject({
      total: 27,
      totals: { backlog: 25, done: 2, executing: 0, in_review: 0, blocked: 0, cancelled: 0 },
      limit: 20,
      offset: 0,
      nextOffset: 20,
    });
    expect(totals.body.workItems.every((item: { version?: number }) => item.version === 1)).toBe(true);

    const second = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?department=route-page-fixture&status=backlog&limit=20&offset=20"),
      second.res,
      ctx,
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ total: 25, limit: 20, offset: 20, nextOffset: null });
    expect(second.body.workItems).toHaveLength(5);
  });

  it("AND-composes status, assignee, department, source, q, since, and until on list and search", async () => {
    const match = store.createWorkItem({
      title: "route-filter-needle",
      body: "body",
      status: "backlog",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
    });
    const bodyOnly = store.createWorkItem({
      title: "route body candidate",
      body: "route-filter-needle in body",
      status: "backlog",
      assignee: "someone-else",
      department: "somewhere-else",
      source: "connector",
    });
    const outside = store.createWorkItem({
      title: "route-filter-needle outside",
      status: "backlog",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
    });
    const db = dbModule.initDb();
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-10T08:00:00.000Z", match.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-11T08:00:00.000Z", bodyOnly.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-03-01T08:00:00.000Z", outside.id);
    store.updateWorkItem(match.id, { rank: 7 }, "operator");
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2033-02-10T08:00:00.000Z", match.id);

    const query = new URLSearchParams({
      status: "backlog",
      assignee: "route-filter-person",
      department: "route-filter-department",
      source: "connector",
      q: "route-filter-needle",
      since: "2033-02-10T08:00:00+00:00",
      until: "2033-02-28",
      limit: "20",
    });
    for (const pathname of [`/api/work-items?${query}`, `/api/search/work-items?${query}`]) {
      const cap = makeRes();
      await api.handleApiRequest(makeReq("GET", pathname), cap.res, ctx);
      expect(cap.status).toBe(200);
      expect(cap.body.workItems.map((item: { id: string }) => item.id)).toEqual([match.id]);
      expect(cap.body.workItems[0]).toMatchObject({ rank: 7 });
      expect(cap.body).toMatchObject({ total: 1, totals: { backlog: 1 }, offset: 0, nextOffset: null });
    }

    const qMatches = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?q=route-filter-needle&source=connector&limit=100"), qMatches.res, ctx);
    expect(new Set(qMatches.body.workItems.map((item: { id: string }) => item.id))).toEqual(new Set([match.id, bodyOnly.id, outside.id]));

    const legacyText = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/search/work-items?text=route-filter-needle&source=connector&limit=100"), legacyText.res, ctx);
    expect(new Set(legacyText.body.workItems.map((item: { id: string }) => item.id))).toEqual(new Set([match.id, bodyOnly.id, outside.id]));
  });

  it.each([
    ["offset=-1", /offset/i],
    ["offset=1.5", /offset/i],
    ["offset=9007199254740992", /offset/i],
    ["limit=0", /limit/i],
    ["limit=2x", /limit/i],
    ["since=not-a-date", /since/i],
    ["until=not-a-date", /until/i],
    ["since=2033-03-01T00%3A00%3A00.000Z&until=2033-02-01T00%3A00%3A00.000Z", /since.*until|range/i],
  ])("rejects invalid list query %s", async (query, message) => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items?${query}`), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(message);
  });
});

describe("GET /api/work-items — the match reason on a searched page", () => {
  it("carries field, commentId and snippet over HTTP, and omits them without a query", async () => {
    const comments = await import("../../work-items/comment-add.js");
    const wi = store.createWorkItem({ title: "Route match reason", body: "Nothing findable here." });
    const comment = comments.addComment({
      workItemId: wi.id,
      body: "Hidden sporangiferous reason.",
      author: "operator",
      authorKind: "operator",
    });

    const searched = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?q=sporangiferous&limit=100"), searched.res, ctx);
    expect(searched.status).toBe(200);
    expect(searched.body.workItems.map((item: { id: string }) => item.id)).toEqual([wi.id]);
    expect(searched.body.matches[wi.id]).toEqual([
      { field: "comment", commentId: comment.id, snippet: expect.stringContaining("<mark>sporangiferous</mark>") },
    ]);

    const unsearched = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?limit=1"), unsearched.res, ctx);
    expect(unsearched.status).toBe(200);
    expect("matches" in unsearched.body).toBe(false);
  });
});
