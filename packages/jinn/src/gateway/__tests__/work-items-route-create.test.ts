import { describe, it, expect } from "vitest";
import { CALLER_SESSION_CAPABILITY_HEADER, CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE } from "../../mcp/identity.js";
import { api, ctx, dbModule, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

describe("POST /api/work-items — provenance and approval routing fields", () => {
  it("rejects caller-supplied provenance and assigns normal tool-created Todos to the session source", async () => {
    const caller = reg.createSession({ engine: "codex", source: "web", sourceRef: "caller", title: "caller", employee: "platform-worker" });

    const spoof = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Spoof", provenance: { source: "workflow", sourceRef: "workflow:wf:run" } }, toolHeaders(caller.id)), spoof.res, ctx);
    expect(spoof.status).toBe(400);
    expect(spoof.body.error).toContain("cron and delegation create their own records");
    expect(spoof.body.error).toContain("source=workflow is historical audit provenance and is not currently minted");
    expect(spoof.body.error).not.toMatch(/cron\/workflow\/delegation source records are minted|dedicated bridges?/i);
    const owned = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Owned", assignee: "platform-worker" }, toolHeaders(caller.id)), owned.res, ctx);
    expect(owned.status).toBe(400);
    expect(owned.body.error).toMatch(/assign_work_item.+POST \/api\/work-items\/:id\/assign/);

    const ok = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", { title: "Normal" }, toolHeaders(caller.id)), ok.res, ctx);
    expect(ok.status).toBe(201);
    expect(ok.body.workItem).toMatchObject({ source: "session", approvalTarget: null, approvalEscalatedAt: null });
    expect(ok.body.workItem.sourceRef).toMatch(new RegExp(`^session:${caller.id}:`));
  });

  it("returns approvalTarget in compact and full API records", async () => {
    const wi = store.createWorkItem({ title: "Approval target row", source: "human" });
    const approvals = await import("../../work-items/approvals.js");
    approvals.requestApproval(wi.id, { request: "decide", target: "coo" });

    const list = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work-items?limit=20"), list.res, ctx);
    expect(list.status).toBe(200);
    expect((list.body.workItems as Array<Record<string, unknown>>).find((item) => item.id === wi.id)).toMatchObject({
      approvalTarget: "coo",
      approvalState: "pending",
    });

    const full = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/work-items/${wi.id}`), full.res, ctx);
    expect(full.status).toBe(200);
    expect(full.body.workItem).toMatchObject({ approvalTarget: "coo", approvalEscalatedAt: null });
  });

  it("returns a capability-scoped needs-attention queue ordered by updatedAt with compact run/session refs", async () => {
    const coo = reg.createSession({ engine: "codex", source: "web", sourceRef: "coo-attn", title: "coo", employee: "coo" });
    const worker = reg.createSession({ engine: "codex", source: "web", sourceRef: "worker-attn", title: "worker", employee: "platform-worker" });

    const cooApproval = store.createWorkItem({ title: "COO approval", source: "workflow", sourceRef: "workflow:wf-coo:run-1", status: "in_review" });
    const workerApproval = store.createWorkItem({ title: "Worker approval", source: "workflow", sourceRef: "workflow:wf-worker:run-2", status: "in_review" });
    const cooBlocked = store.createWorkItem({ title: "COO blocked", source: "session", sourceRef: `session:${coo.id}:abc123`, assignee: "coo", status: "blocked" });
    const cooNormal = store.createWorkItem({ title: "COO normal", assignee: "coo", status: "backlog" });

    const approvals = await import("../../work-items/approvals.js");
    approvals.requestApproval(cooApproval.id, { request: "approve coo", target: "coo" });
    approvals.requestApproval(workerApproval.id, { request: "approve worker", target: "platform-worker" });

    const db = dbModule.initDb();
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T10:00:00.000Z", cooApproval.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T12:00:00.000Z", cooBlocked.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T13:00:00.000Z", workerApproval.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-07-06T14:00:00.000Z", cooNormal.id);

    const cooQueue = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=2", undefined, toolHeaders(coo.id)),
      cooQueue.res,
      ctx,
    );
    expect(cooQueue.status).toBe(200);
    expect((cooQueue.body.workItems as Array<{ id: string }>).map((item) => item.id)).toEqual([cooBlocked.id, cooApproval.id]);
    expect(cooQueue.body.workItems[0]).toMatchObject({
      id: cooBlocked.id,
      sessionRef: { sessionId: coo.id },
      approvalState: null,
      approvalTarget: null,
    });
    expect(cooQueue.body.workItems[1]).toMatchObject({
      id: cooApproval.id,
      sessionRef: null,
      approvalState: "pending",
      approvalTarget: "coo",
    });
    expect(cooQueue.body.workItems[0]).not.toHaveProperty("workflowRun");
    expect(cooQueue.body.workItems[1]).not.toHaveProperty("workflowRun");

    const workerQueue = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me&limit=10", undefined, toolHeaders(worker.id)),
      workerQueue.res,
      ctx,
    );
    expect(workerQueue.status).toBe(200);
    expect((workerQueue.body.workItems as Array<{ id: string }>).map((item) => item.id)).toEqual([workerApproval.id]);

    const spoof = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=coo&limit=10", undefined, toolHeaders(worker.id)),
      spoof.res,
      ctx,
    );
    expect(spoof.status).toBe(403);
    expect(spoof.body.error).toMatch(/own queue|needsAttentionFor=me|cannot read/i);

    const badCapability = makeRes();
    await api.handleApiRequest(
      makeReq("GET", "/api/work-items?needsAttentionFor=me", undefined, {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: coo.id,
        [CALLER_SESSION_CAPABILITY_HEADER]: "bad-capability",
      }),
      badCapability.res,
      ctx,
    );
    expect(badCapability.status).toBe(403);
  });
});

describe("POST /api/work-items — Todos v2 sub-task creation", () => {
  it("creates a sub-task with parentId/dueAt/priority and stamps createdBy from the caller", async () => {
    const rootRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "v2 tree root" }, operatorHeaders),
      rootRes.res,
      ctx,
    );
    expect(rootRes.status).toBe(201);
    const root = rootRes.body.workItem;
    expect(root.createdBy).toBe("operator");
    expect(root.parentId).toBeNull();
    expect(root.rootId).toBe(root.id);
    expect(root.depth).toBe(0);

    const childRes = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", {
        title: "v2 sub-task",
        parentId: root.id,
        dueAt: "2026-08-01T00:00:00.000Z",
        priority: 1,
      }, operatorHeaders),
      childRes.res,
      ctx,
    );
    expect(childRes.status).toBe(201);
    expect(childRes.body.workItem).toMatchObject({
      parentId: root.id,
      rootId: root.id,
      depth: 1,
      dueAt: "2026-08-01T00:00:00.000Z",
      priority: 1,
      createdBy: "operator",
    });
  });

  it("stamps the resolved employee SLUG as createdBy; session:<uuid> only for employee-less sessions (slice-5 decision 7)", async () => {
    const employeeSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "createdby-emp", employee: "platform-worker" });
    const bareSession = reg.createSession({ engine: "codex", source: "web", sourceRef: "createdby-bare" });

    const bySlug = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "slug-created" }, toolHeaders(employeeSession.id)),
      bySlug.res,
      ctx,
    );
    expect(bySlug.status).toBe(201);
    expect(bySlug.body.workItem.createdBy).toBe("platform-worker");

    const bySession = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "bare-created" }, toolHeaders(bareSession.id)),
      bySession.res,
      ctx,
    );
    expect(bySession.status).toBe(201);
    expect(bySession.body.workItem.createdBy).toBe(`session:${bareSession.id}`);
  });

  it("inherits the parent's department (and prefix) when the request body has no department key", async () => {
    const root = store.createWorkItem({ title: "inherit root", department: "platform" });

    const inherited = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "inherit child", parentId: root.id }, operatorHeaders),
      inherited.res,
      ctx,
    );
    expect(inherited.status).toBe(201);
    expect(inherited.body.workItem.department).toBe("platform");
    expect(inherited.body.workItem.id.slice(0, 3)).toBe(root.id.slice(0, 3));

    const explicitNull = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "no-dept child", parentId: root.id, department: null }, operatorHeaders),
      explicitNull.res,
      ctx,
    );
    expect(explicitNull.status).toBe(201);
    expect(explicitNull.body.workItem.department).toBeNull();
    expect(explicitNull.body.workItem.id.slice(0, 3)).toBe("JIN"); // company prefix

    const explicitString = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "marketing child", parentId: root.id, department: "marketing" }, operatorHeaders),
      explicitString.res,
      ctx,
    );
    expect(explicitString.status).toBe(201);
    expect(explicitString.body.workItem.department).toBe("marketing");
    expect(explicitString.body.workItem.id.slice(0, 3)).not.toBe(root.id.slice(0, 3));
  });

  it("normalizes dueAt to a canonical ISO instant", async () => {
    const dateOnly = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/work-items", { title: "date-only due", dueAt: "2026-08-01" }, operatorHeaders),
      dateOnly.res,
      ctx,
    );
    expect(dateOnly.status).toBe(201);
    expect(dateOnly.body.workItem.dueAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it.each([
    ["a non-ISO dueAt", { title: "sloppy due", dueAt: "Jan 1 2026" }, /ISO 8601/],
    ["a malformed dueAt", { title: "bad due", dueAt: "not-a-date" }, /ISO 8601/],
    ["an out-of-range priority", { title: "bad priority", priority: 9 }, /priority/],
    ["an unknown parent", { title: "orphan", parentId: "ZZZ-999" }, /not found/],
  ] as const)("rejects %s", async (_name, body, message) => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/work-items", body, operatorHeaders), cap.res, ctx);
    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(message);
  });
});
