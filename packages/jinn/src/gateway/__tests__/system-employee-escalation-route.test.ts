import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "../system-employees.js";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * The way out when a system employee can place nobody.
 *
 * A Todo that matches no Workflow and fits no employee must not dead-end at a
 * comment: the Dispatcher and the Shaper move it to blocked with a note and a
 * comment saying why, which puts it on the operator's queue. Neither employee
 * manages anyone and neither is the org root, so what lets them through is the
 * agent status lane: open to any authenticated session, bounded to the open
 * statuses. Pinned here because a persona naming a verb the route refuses is
 * prose, not a hand-off.
 */

let registry: Registry;
let workItems: WorkItems;

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function systemSession(employee: string, sourceRef: string) {
  return registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef,
    connector: "web",
    employee,
    prompt: "ICI-9: nobody on the roster fits this",
  });
}

const WHY = "No Workflow covers this and no employee is a credible fit; the operator must name the owner.";

async function blockForOperator(itemId: string, sessionId: string) {
  const blocked = await call("POST", `/api/work-items/${itemId}/status`, { status: "blocked", note: WHY }, callerHeaders(sessionId));
  const commented = await call("POST", `/api/work-items/${itemId}/comments`, { body: WHY }, callerHeaders(sessionId));
  return { blocked, commented };
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/work-items/:id/status: the system employees' way out", () => {
  it("lets the Dispatcher block a Todo its session is linked to, with a comment", async () => {
    const dispatcher = systemSession(TODO_DISPATCHER_NAME, "todo-dispatcher:escalate-1");
    const item = workItems.createWorkItem({
      title: "Rewrite the onboarding voiceover in Portuguese",
      source: "human",
      department: "platform",
      status: "executing",
    });
    workItems.linkSession(item.id, dispatcher.id);

    const { blocked, commented } = await blockForOperator(item.id, dispatcher.id);

    expect([blocked.status, blocked.body.workItem.status]).toEqual([200, "blocked"]);
    expect(commented.status).toBe(201);
    expect(workItems.getWorkItem(item.id)?.status).toBe("blocked");
  });

  it("lets the Shaper block the Todo it created when dispatch was refused", async () => {
    const shaper = systemSession(TODO_SHAPER_NAME, "todo-shaper:escalate-1");
    const item = workItems.createWorkItem({
      title: "Rewrite the onboarding voiceover in Portuguese",
      source: "session",
      sourceRef: `session:${shaper.id}:idempotency:escalate-1`,
      createdBy: `session:${shaper.id}`,
      department: "platform",
    });

    const { blocked, commented } = await blockForOperator(item.id, shaper.id);

    expect([blocked.status, blocked.body.workItem.status]).toEqual([200, "blocked"]);
    expect(commented.status).toBe(201);
  });

  // The lane is bounded: a system employee can stop a Todo, not close it.
  it("still refuses a system employee closing a Todo", async () => {
    const dispatcher = systemSession(TODO_DISPATCHER_NAME, "todo-dispatcher:escalate-2");
    const item = workItems.createWorkItem({
      title: "Someone else's Todo",
      source: "human",
      department: "platform",
      assignee: "route-worker",
      status: "executing",
    });

    const resp = await call("POST", `/api/work-items/${item.id}/status`, { status: "done", note: WHY }, callerHeaders(dispatcher.id));

    expect(resp.status).toBe(403);
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");
  });
});
