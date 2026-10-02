import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

describe("PUT/POST /api/work-items/:id/status — the operator authority lane", () => {
  // Every declared edge the operator drives, with the audit event each one must
  // leave behind. The cancellation rows also cover the archive lane, which has
  // to carry the same human authority the PUT lane carries for every other
  // sticky exit (Stage-A review F2).
  it.each([
    ["backlog", "executing", { fromStatus: "backlog", toStatus: "executing", actor: "operator" }],
    ["backlog+assignee", "executing", { fromStatus: "backlog", toStatus: "executing", actor: "operator" }],
    ["backlog", "cancelled", { kind: "status_change", fromStatus: "backlog", toStatus: "cancelled", actor: "operator" }],
    ["backlog+assignee", "cancelled", { kind: "status_change", fromStatus: "backlog", toStatus: "cancelled", actor: "operator" }],
    ["executing", "cancelled", { kind: "status_change", fromStatus: "executing", toStatus: "cancelled", actor: "operator" }],
    ["in_review", "cancelled", { kind: "status_change", fromStatus: "in_review", toStatus: "cancelled", actor: "operator" }],
    ["blocked", "cancelled", { kind: "status_change", fromStatus: "blocked", toStatus: "cancelled", actor: "operator" }],
  ] as const)("round-trips an authenticated operator PUT from %s to %s", async (from, to, expectedEvent) => {
    // "backlog+assignee" is what `assigned` used to be: backlog, owned by someone.
    const owned = from === "backlog+assignee";
    const item = store.createWorkItem({
      title: `Operator ${from} to ${to}`,
      status: owned ? "backlog" : from,
      ...(owned ? { assignee: "platform-worker" } : {}),
    });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: to }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body.workItem.status).toBe(to);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject(expectedEvent);
  });

  // The `actor` filter on a todo-status Workflow trigger is only an authority
  // boundary if the operator string is exclusive to the operator surface. An
  // employee session moving the SAME Todo the SAME way must never record it.
  it("stamps an employee session's identical transition as session:<id>, never as the operator", async () => {
    const item = store.createWorkItem({ title: "Employee start", status: "backlog", assignee: "platform-worker" });
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "web:employee-actor", employee: "platform-worker" });
    store.linkSession(item.id, caller.id);
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${item.id}/status`, { status: "executing" }, toolHeaders(caller.id)),
      cap.res,
      ctx,
    );

    expect([cap.status, cap.body]).toEqual([200, expect.anything()]);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "executing",
      actor: `session:${caller.id}`,
    });
  });

  it("keeps done → cancelled rejected (no declared edge, even for the operator)", async () => {
    const item = store.createWorkItem({ title: "Already done", status: "done" });
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "cancelled" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect([400, 403]).toContain(cap.status);
    expect(cap.body.error).toMatch(/illegal transition|human.*decision/i);
    expect(store.getWorkItem(item.id)?.status).toBe("done");
  });

  it.each(["blocked"] as const)(
    "records a same-status %s note through the operator PUT lane (the banner's asked-for-after reason)",
    async (status) => {
      // Design-doc §5: a drop into Blocked commits immediately and the
      // reason is asked for AFTER, in the opened task page's banner. That write
      // is a same-status PUT with a note — it must land as a reason-carrying
      // event (toStatus = the current status so the reason line reads it), not
      // vanish in the transition() same-status no-op.
      const item = store.createWorkItem({ title: `Reasonless ${status}`, status });
      const before = store.getWorkItem(item.id)!.version;
      const cap = makeRes();

      await api.handleApiRequest(
        makeReq("PUT", `/api/work-items/${item.id}/status`, { status, note: "Waiting on vendor keys" }, operatorHeaders),
        cap.res,
        ctx,
      );

      expect(cap.status).toBe(200);
      expect(cap.body.workItem.status).toBe(status);
      const event = store.listWorkItemEvents(item.id).at(-1);
      expect(event).toMatchObject({
        kind: "note",
        toStatus: status,
        actor: "operator",
      });
      expect(event?.detail?.note).toBe("Waiting on vendor keys");
      expect(store.getWorkItem(item.id)!.version).toBeGreaterThan(before);
    },
  );

  it("keeps a same-status operator PUT WITHOUT a note a plain no-op", async () => {
    const item = store.createWorkItem({ title: "No-op blocked", status: "blocked" });
    const events = store.listWorkItemEvents(item.id).length;
    const cap = makeRes();

    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "blocked" }, operatorHeaders),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).length).toBe(events);
  });
});
