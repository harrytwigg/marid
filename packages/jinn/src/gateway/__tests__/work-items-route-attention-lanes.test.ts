import { describe, expect, it } from "vitest";
import { api, ctx, dbModule, makeReq, makeRes, store, toolHeaders, reg } from "./helpers/work-items-route-harness.js";

/**
 * PLA-240 data contract: Attention/list grouping is fed only from
 * GET /api/work-items?needsAttentionFor=me. Recovering leftovers must be in
 * that feed with attentionLane=recovering so the UI can split them out of
 * Needs you.
 */
describe("GET /api/work-items?needsAttentionFor=me attention lanes", () => {
  it("returns a recovering blocked Todo with attentionLane recovering, including for the COO who is not the assignee", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-lanes", title: "coo", employee: "coo" });
    const item = store.createWorkItem({
      title: "quota parked build", status: "blocked", assignee: "platform-worker",
    });
    const rows = await import("../../work-items/recovery-rows.js");
    rows.upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId: "run_old",
      class: "transient",
      lane: "recovering",
      reason: "provider availability",
    });

    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=50", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    const row = (res.body.workItems as Array<Record<string, unknown>>).find((entry) => entry.id === item.id);
    expect(row).toMatchObject({ id: item.id, status: "blocked", attentionLane: "recovering" });
  });

  it("returns a manager-lane in_review leftover", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-mgr", title: "coo", employee: "coo" });
    const item = store.createWorkItem({
      title: "landing leftover", status: "in_review", assignee: "platform-worker",
    });
    const rows = await import("../../work-items/recovery-rows.js");
    rows.upsertWorkItemRecovery({
      workItemId: item.id,
      incidentId: "run_landed",
      class: "operator",
      lane: "manager",
      reason: "the landing is still open",
    });

    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=50", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    const row = (res.body.workItems as Array<Record<string, unknown>>).find((entry) => entry.id === item.id);
    expect(row).toMatchObject({ id: item.id, status: "in_review", attentionLane: "manager" });
  });

  /**
   * Dashboard contract from packages/web: deriveNeedsYou keeps recovering/manager
   * lanes, then grouping splits Recovering automatically / Manager attention / Needs you.
   */
  function dashboardGroups(feed: Array<Record<string, unknown>>) {
    const kept = feed.filter((item) =>
      item.attentionLane === "recovering" || item.attentionLane === "manager"
      || item.status === "blocked");
    return {
      recovering: kept.filter((item) => item.attentionLane === "recovering").map((item) => item.id),
      manager: kept.filter((item) => item.attentionLane === "manager").map((item) => item.id),
      needsYou: kept.filter((item) => item.attentionLane !== "recovering" && item.attentionLane !== "manager").map((item) => item.id),
    };
  }

  async function attentionFeed() {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: `coo-${Date.now()}`, title: "coo", employee: "coo" });
    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=50", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    return res.body.workItems as Array<Record<string, unknown>>;
  }

  it("QPR-4: an unowned in_review leftover survives the recovery tick into Manager attention", async () => {
    const detect = await import("../../work-items/anomaly-detect.js");
    const controller = await import("../../work-items/recovery-controller.js");
    const runs = await import("../../work-items/runs.js");
    const transitions = await import("../../work-items/transitions.js");
    const rows = await import("../../work-items/recovery-rows.js");
    const db = dbModule.initDb();

    const item = store.createWorkItem({
      title: "QPR-4 unowned landing", status: "backlog",
    });
    transitions.transition(item.id, "in_review", "session:worker", { agent: true });
    store.createWorkItem({
      title: "open child leftover", parentId: item.id, status: "backlog", assignee: "platform-worker",
    });
    const sessionId = `s-qpr4-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date().toISOString() });
    expect(store.getWorkItem(item.id)!.status).toBe("in_review");

    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "backlog" }) });
    detect.detectTodoAnomalies({ persist: true });
    expect(rows.getWorkItemRecovery(item.id)?.lane).toBe("manager");

    const feed = await attentionFeed();
    const compact = feed.find((entry) => entry.id === item.id);
    expect(compact).toMatchObject({ id: item.id, status: "in_review", attentionLane: "manager" });
    const groups = dashboardGroups(feed);
    expect(groups.manager).toContain(item.id);
    expect(groups.needsYou).not.toContain(item.id);
  });

  it("QPR-1: recovering leftover survives sweep into Recovering automatically, not Needs you", async () => {
    const controller = await import("../../work-items/recovery-controller.js");
    const runs = await import("../../work-items/runs.js");
    const db = dbModule.initDb();

    const item = store.createWorkItem({
      title: "QPR-1 quota parked", status: "blocked", assignee: "platform-worker",
    });
    const sessionId = `s-qpr1-${item.id}`;
    db.prepare(
      `INSERT INTO sessions (id, engine, source, source_ref, status, work_item_id, created_at, last_activity)
       VALUES (?, 'claude', 'cron', ?, 'idle', ?, ?, ?)`,
    ).run(sessionId, `cron:${sessionId}`, item.id, new Date().toISOString(), new Date().toISOString());
    const run = runs.openWorkItemRun({ workItemId: item.id, sessionId });
    runs.closeWorkItemRun(run.id, {
      outcome: "rate_limited", endedAt: new Date().toISOString(),
      error: "Usage limit exceeded; try again at 2026-08-27T12:00:00.000Z",
    });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "backlog", toStatus: "blocked",
      actor: "workflow:run", detail: { workflowId: "pipeline", runId: run.id }, versionEffect: "audit",
    });

    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "backlog" }) });
    const feed = await attentionFeed();
    const compact = feed.find((entry) => entry.id === item.id);
    expect(compact).toMatchObject({ id: item.id, attentionLane: "recovering" });
    const groups = dashboardGroups(feed);
    expect(groups.recovering).toContain(item.id);
    expect(groups.needsYou).not.toContain(item.id);
  });

  async function compactRows() {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: `coo-rows-${Date.now()}`, title: "coo", employee: "coo" });
    const res = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?limit=100", undefined, toolHeaders(coo.id)),
      res.res,
      ctx,
    );
    expect(res.status).toBe(200);
    return res.body.workItems as Array<Record<string, unknown>>;
  }

  /** `work_item_recovery` only describes a Todo while it sits in a
   *  status the recovery sweep visits (`SWEEP_STATUSES`). A blocked→backlog
   *  re-queue leaves that row behind, and `attentionLaneOf` read it before
   *  anything else — so the Todo kept a lane it no longer had a reason for. */
  it("an operator lane classified while blocked is gone once the Todo is re-queued to backlog", async () => {
    const controller = await import("../../work-items/recovery-controller.js");
    const transitions = await import("../../work-items/transitions.js");
    const rows = await import("../../work-items/recovery-rows.js");

    const item = store.createWorkItem({ title: "re-check re-queued to backlog", status: "blocked" });
    controller.sweepTodoRecovery({ mode: "classify-only", rearm: () => ({ status: "backlog" }) });
    expect(rows.getWorkItemRecovery(item.id)).toMatchObject({ class: "operator", lane: "operator" });

    const before = (await compactRows()).find((entry) => entry.id === item.id);
    expect(before).toMatchObject({ status: "blocked", attentionLane: "operator" });

    transitions.transition(item.id, "backlog", "operator");
    expect(store.getWorkItem(item.id)!.status).toBe("backlog");

    const after = (await compactRows()).find((entry) => entry.id === item.id);
    expect(after).toMatchObject({ status: "backlog", attentionLane: null });
  });

  it("a manager-lane row does not keep a backlog Todo in the needs-attention feed", async () => {
    const transitions = await import("../../work-items/transitions.js");
    const rows = await import("../../work-items/recovery-rows.js");

    const item = store.createWorkItem({ title: "failed build", status: "blocked", assignee: "platform-worker" });
    rows.upsertWorkItemRecovery({
      workItemId: item.id, incidentId: `run_${item.id}`, class: "code", lane: "manager",
      reason: "the attempt failed in the work itself",
    });

    const before = await attentionFeed();
    expect(before.find((entry) => entry.id === item.id)).toMatchObject({ status: "blocked", attentionLane: "manager" });

    transitions.transition(item.id, "backlog", "operator");
    expect(store.getWorkItem(item.id)!.status).toBe("backlog");

    const after = await attentionFeed();
    expect(after.find((entry) => entry.id === item.id)).toBeUndefined();
    expect((await compactRows()).find((entry) => entry.id === item.id)).toMatchObject({ status: "backlog", attentionLane: null });
  });
});
