import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* The board's design contract (design-doc §5/§6) requires the human-only
 * edges transitions.ts already supports: reopening closed work and unblocking.
 * The operator PUT lane carries human authority — it passes human:true,
 * accepts every declared status target, and treats the blocked note as
 * asked-for-after (optional) rather than demanded up front. The agent lane
 * still demands that note; its move matrix is pinned in
 * work-items-route-status-lanes.test.ts. */
describe("PUT /api/work-items/:id/status — the operator human-surface lane (Todos v2 slice 6)", () => {
  it.each([
    // Drag-to-Backlog reopen: closed work loses its closedAt as it comes back.
    ["done", "backlog", { status: "backlog", closedAt: null }],
    ["cancelled", "backlog", { status: "backlog", closedAt: null }],
    ["blocked", "backlog", { status: "backlog" }],
    ["blocked", "in_review", { status: "in_review" }],
    // No note: the reason is asked for in the banner after the drop commits.
    ["executing", "blocked", { status: "blocked" }],
  ] as const)("moves %s → %s on the human-only edges", async (from, target, expectedItem) => {
    const item = store.createWorkItem({ title: `Human edge ${from} to ${target}`, status: from });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(cap.body.workItem).toMatchObject(expectedItem);
  });

  it("still records the note when the operator PUT provides one", async () => {
    const item = store.createWorkItem({ title: "Block with note", status: "executing" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: "blocked", note: "needs owner call" }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(200);
    expect(store.listWorkItemEvents(item.id).at(-1)).toMatchObject({
      toStatus: "blocked",
      detail: { note: "needs owner call" },
    });
  });

  it.each([
    ["a truly illegal edge", "in_review", "backlog", [/illegal transition in_review → backlog/]],
    // A declared edge, but a manual start is only ever from backlog.
    ["a manual start from blocked", "blocked", "executing", [/illegal manual transition blocked → executing/]],
    // The refusal names every status, so the operator can see what was allowed.
    ["an unknown status", "backlog", "paused", [/status must be one of/, /backlog/]],
  ] as const)("still refuses an operator PUT along %s", async (_name, from, target, messages) => {
    const item = store.createWorkItem({ title: `Refused ${from} to ${target}`, status: from });
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${item.id}/status`, { status: target }, operatorHeaders),
      cap.res,
      ctx,
    );
    expect(cap.status).toBe(400);
    for (const message of messages) expect(cap.body.error).toMatch(message);
    expect(store.getWorkItem(item.id)?.status).toBe(from);
  });

  it("keeps the agent lane demanding a note to block, which the operator PUT lane does not", async () => {
    const caller = reg.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "agent-lane-pin",
      employee: "platform-worker",
    });
    const owned = store.createWorkItem({ title: "Agent block needs a note", status: "executing", assignee: "platform-worker" });

    const noteLess = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/work-items/${owned.id}/status`, { status: "blocked" }, toolHeaders(caller.id)),
      noteLess.res,
      ctx,
    );
    expect(noteLess.status).toBe(400);
    expect(noteLess.body.error).toMatch(/note is required/);
    expect(store.getWorkItem(owned.id)?.status).toBe("executing");
  });
});
