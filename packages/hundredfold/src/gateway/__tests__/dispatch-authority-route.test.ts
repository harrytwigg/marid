import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * Who may start the Dispatcher on a Todo.
 *
 * The Todo Shaper's design rests on the answer: the Todo Shaper creates a Todo and hands it
 * straight on, so quick capture only works if a session has standing over what
 * it created. It does, and by an existing rule rather than a new exception —
 * the approval route resolves an unassigned Todo's owner to the employee behind
 * its source session. That is also why the Shaper's persona forbids setting an
 * assignee: an assignee it wrote would become the owner instead, and the Shaper
 * would lose the Todo it had just made.
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

function shaperSession(sourceRef: string) {
  return registry.createSession({
    engine: "codex",
    source: "web",
    sourceRef,
    connector: "web",
    employee: "todo-shaper",
    prompt: "the closed rail scrolls under the header on mobile",
  });
}

beforeAll(async () => {
  ({ registry, workItems } = await startRouteHarness());
});

afterAll(async () => {
  await stopRouteHarness();
});

describe("POST /api/work-items/:id/dispatch — caller standing", () => {
  it("lets the session that created an unassigned Todo dispatch it", async () => {
    const shaper = shaperSession("todo-shaper:capture-1");
    const item = workItems.createWorkItem({
      title: "Closed rail scrolls under the board header on mobile",
      source: "session",
      sourceRef: `session:${shaper.id}:idempotency:capture-1`,
      createdBy: `session:${shaper.id}`,
      department: "platform",
    });

    const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {}, callerHeaders(shaper.id));

    expect(response.status).toBe(201);
    expect(registry.getSession(response.body.sessionId)).toMatchObject({ employee: "todo-dispatcher" });
  });

  // The other half of the same rule: standing is what the gate checks, so a
  // session with none is still refused. Without this the test above would pass
  // just as well against no gate at all.
  it("refuses a session with no standing over the Todo, naming the employee", async () => {
    const stranger = registry.createSession({
      engine: "codex",
      source: "web",
      sourceRef: "route-worker:unrelated",
      connector: "web",
      employee: "route-worker",
      prompt: "unrelated work",
    });
    const item = workItems.createWorkItem({ title: "Not this session's Todo", source: "human" });
    const sessionsBefore = registry.countSessions();

    const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {}, callerHeaders(stranger.id));

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/route-worker/);
    expect(response.body.error).toMatch(/dispatch/);
    expect(registry.countSessions()).toBe(sessionsBefore);
  });

  // An assignee the Shaper wrote would take ownership away from it. The persona
  // forbids that; this is the refusal it would meet if it ever stopped obeying.
  it("refuses the creating session once the Todo is assigned to someone else", async () => {
    const shaper = shaperSession("todo-shaper:capture-2");
    const item = workItems.createWorkItem({
      title: "Assigned away from its creator",
      source: "session",
      sourceRef: `session:${shaper.id}:idempotency:capture-2`,
      createdBy: `session:${shaper.id}`,
      assignee: "route-worker",
      department: "platform",
    });

    const response = await call("POST", `/api/work-items/${item.id}/dispatch`, {}, callerHeaders(shaper.id));

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/todo-shaper/);
  });
});
