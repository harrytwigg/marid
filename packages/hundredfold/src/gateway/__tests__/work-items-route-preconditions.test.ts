import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store } from "./helpers/work-items-route-harness.js";

describe("PATCH /api/work-items/:id — preconditions, conflicts, and idempotency", () => {
  it("requires a positive expected version, accepts an equivalent If-Match, and rejects disagreement", async () => {
    const item = store.createWorkItem({ title: "Preconditions" });

    const missing = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, { title: "missing" }, operatorHeaders), missing.res, ctx);
    expect(missing.status).toBe(428);
    expect(missing.body).toEqual({ error: "A current Todo version is required.", code: "todo_precondition_required" });

    for (const expectedVersion of [0, -1, 1.5, "1", null]) {
      const malformed = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { title: "bad", expectedVersion }, operatorHeaders),
        malformed.res,
        ctx,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "Todo version must be a positive safe integer.", code: "todo_invalid_version" });
    }

    for (const ifMatch of ['W/"1"', '"0"', '"1", "2"', 'not-a-version']) {
      const malformed = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${item.id}`, { title: "bad header" }, { ...operatorHeaders, "if-match": ifMatch }),
        malformed.res,
        ctx,
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "Todo version must be a positive safe integer.", code: "todo_invalid_version" });
    }

    const mismatch = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "mismatch", expectedVersion: 1 }, { ...operatorHeaders, "if-match": '"2"' }),
      mismatch.res,
      ctx,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: "Todo version preconditions do not match.", code: "todo_invalid_version" });

    const header = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "header success" }, { ...operatorHeaders, "if-match": '"1"' }),
      header.res,
      ctx,
    );
    expect(header.status).toBe(200);
    expect(header.body.workItem).toMatchObject({ title: "header success", version: 2 });
  });

  it("allows exactly one same-version save and returns only a sanitized typed conflict", async () => {
    const item = store.createWorkItem({ title: "Race" });
    const first = makeRes();
    const second = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "winner", expectedVersion: item.version }, operatorHeaders),
      first.res,
      ctx,
    );
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "loser", expectedVersion: item.version }, operatorHeaders),
      second.res,
      ctx,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: "Todo changed since it was loaded.",
      code: "todo_version_conflict",
      currentVersion: 2,
    });
    expect(JSON.stringify(second.body)).not.toMatch(/wi_|SQLITE|\/private|\/srv|\.db/i);
  });

  it("replays a lost response by idempotency key without another event or version bump", async () => {
    const item = store.createWorkItem({ title: "Before lost response" });
    const beforeEvents = store.listWorkItemEvents(item.id).length;
    const request = { title: "Committed", expectedVersion: item.version, idempotencyKey: "todo:edit:lost-response-one" };

    const lost = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, request, operatorHeaders), lost.res, ctx);
    const retry = makeRes();
    await api.handleApiRequest(makeReq("PATCH", `/api/work-items/${item.id}`, request, operatorHeaders), retry.res, ctx);

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, workItem: { title: "Committed", version: 2 } });
    expect(store.listWorkItemEvents(item.id)).toHaveLength(beforeEvents + 1);

    const misuse = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { ...request, title: "different private content" }, operatorHeaders),
      misuse.res,
      ctx,
    );
    expect(misuse.status).toBe(409);
    expect(misuse.body).toEqual({
      error: "This Todo edit key was already used for a different request.",
      code: "todo_idempotency_conflict",
      currentVersion: 2,
    });
    expect(JSON.stringify(misuse.body)).not.toContain("different private content");
  });

  it("invalidates stale edits after status and reconciler changes", async () => {
    const transitions = await import("../../work-items/transitions.js");
    const reconcile = await import("../../work-items/reconcile.js");
    const stale: Array<{ id: string; version: number; currentVersion: number }> = [];

    const statusItem = store.createWorkItem({ title: "status stale" });
    transitions.transition(statusItem.id, "executing", "system");
    stale.push({ id: statusItem.id, version: statusItem.version, currentVersion: 2 });

    const reconciledItem = store.createWorkItem({ title: "reconcile stale", source: "session" });
    const session = reg.createSession({ engine: "codex", source: "web", sourceRef: "route-cas-reconcile" });
    store.linkSession(reconciledItem.id, session.id);
    const beforeReconcile = store.getWorkItem(reconciledItem.id)!.version;
    reg.updateSession(session.id, { status: "running" });
    reconcile.reconcileWorkItem(reconciledItem.id);
    stale.push({ id: reconciledItem.id, version: beforeReconcile, currentVersion: beforeReconcile + 1 });

    for (const target of stale) {
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("PATCH", `/api/work-items/${target.id}`, { title: "stale edit", expectedVersion: target.version }, operatorHeaders),
        cap.res,
        ctx,
      );
      expect(cap.status).toBe(409);
      expect(cap.body).toMatchObject({ code: "todo_version_conflict", currentVersion: target.currentVersion });
    }
  });

  it("implements overwrite only as refetch-current-version followed by a normal conditional PATCH", async () => {
    const item = store.createWorkItem({ title: "local desired" });
    store.updateWorkItem(item.id, { title: "remote winner" }, "other-tab");

    const stale = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "local desired", expectedVersion: item.version }, operatorHeaders),
      stale.res,
      ctx,
    );
    expect(stale.status).toBe(409);

    const refreshed = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${item.id}`), refreshed.res, ctx);
    const overwriteVersion = refreshed.body.workItem.version;
    const overwrite = makeRes();
    await api.handleApiRequest(
      makeReq("PATCH", `/api/work-items/${item.id}`, { title: "local desired", expectedVersion: overwriteVersion }, operatorHeaders),
      overwrite.res,
      ctx,
    );
    expect(overwrite.status).toBe(200);
    expect(overwrite.body).toMatchObject({ replayed: false, workItem: { title: "local desired", version: overwriteVersion + 1 } });
  });
});
