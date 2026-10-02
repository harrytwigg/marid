import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignedTodo,
  delegate,
  dispatch,
  employeeSession,
  registry,
  sessionsOf,
  startDispatchHarness,
  stopDispatchHarness,
  workItems,
} from "./dispatch-assigned-harness.js";

/**
 * Dispatch on a Todo somebody already owns: a backlog Todo with an assignee,
 * which is all "assigned" means now.
 *
 * The Dispatcher routes for the operator who pressed the button. On an
 * unassigned Todo its own link made it the owner, so delegation passed the
 * owner rule by accident; on an owned one the owner is the assignee, and
 * the Dispatcher's one job ended in a 403 inside its session. These tests pin
 * the sanctioned path (a Dispatcher may hand on the Todo it was started for,
 * once, and nothing else) and the guard it must not weaken.
 */

beforeAll(startDispatchHarness);
afterAll(stopDispatchHarness);

describe("Dispatch on a backlog Todo that has an assignee", () => {
  // The regression: this delegation used to be refused with "does not own
  // Todo ... and is not its authorized manager/root".
  it("lets the Dispatcher re-route an owned Todo to the employee it picked", async () => {
    const item = assignedTodo("Assigned by the operator, re-routed by Dispatch");

    const dispatched = await dispatch(item.id);
    expect(dispatched.status).toBe(201);
    const dispatcherId = dispatched.body.sessionId as string;
    expect(registry.getSession(dispatcherId)?.employee).toBe("todo-dispatcher");

    const delegated = await delegate(dispatcherId, item.id, "second-worker");

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({
      employee: "second-worker",
      parentSessionId: dispatcherId,
      workItemId: item.id,
      workItemRole: "execute",
    });
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "second-worker", status: "executing" });
  });

  it("lets the Dispatcher start the existing assignee, tracked on the same Todo", async () => {
    const item = assignedTodo("Assigned by the operator, started by Dispatch");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, item.id, "first-worker");

    expect(delegated.status).toBe(201);
    expect(delegated.body.workItemId).toBe(item.id);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ employee: "first-worker", workItemId: item.id });
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
  });

  it("puts the status and current assignee in the Dispatcher's brief", async () => {
    const item = assignedTodo("Brief names the assignee");

    const dispatched = await dispatch(item.id);

    const prompt = registry.getMessages(dispatched.body.sessionId).find((message) => message.role === "user")?.content;
    expect(prompt).toContain("Status: backlog");
    expect(prompt).toContain("Assignee: first-worker");
  });
});

describe("delegate_task ownership guard", () => {
  it("still refuses an employee that is not the Todo's owner, manager or root", async () => {
    const item = assignedTodo("Owned by the first worker");
    const outsider = employeeSession("second-worker", "outsider:1");

    const delegated = await delegate(outsider.id, item.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/employee "second-worker" does not own Todo .* cannot delegate/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker", status: "backlog" });
  });

  it("binds a Dispatcher to the Todo it was started for and no other", async () => {
    const dispatchedFor = assignedTodo("The Todo the Dispatcher was started for");
    const other = assignedTodo("Somebody else's Todo");
    const dispatcherId = (await dispatch(dispatchedFor.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, other.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/employee "todo-dispatcher" does not own Todo/);
    expect(workItems.getWorkItem(other.id)).toMatchObject({ assignee: "first-worker" });
  });

  // The standing comes from the gateway having started the session, not from
  // the employee name: a session that merely calls itself the Dispatcher and is
  // linked to the Todo gets the ordinary rule.
  it("refuses a todo-dispatcher session the gateway did not start on that Todo", async () => {
    const item = assignedTodo("Claimed by an impostor");
    const impostor = employeeSession("todo-dispatcher", "impostor:1");
    workItems.linkSession(item.id, impostor.id);
    registry.updateSession(impostor.id, { status: "idle" });

    const delegated = await delegate(impostor.id, item.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/todo-dispatcher/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
  });

  // The delegate is the Dispatcher's child, so its callbacks wake the
  // Dispatcher. Woken after its producer went idle (waiting on a review, say),
  // the Dispatcher must not be able to reassign the Todo and start a second
  // attempt: its standing ended with the hand-off.
  it("ends the Dispatcher's standing at the hand-off, so a woken Dispatcher cannot re-route", async () => {
    const item = assignedTodo("Handed off, producer now idle");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const delegated = await delegate(dispatcherId, item.id, "first-worker");
    expect(delegated.status).toBe(201);
    registry.updateSession(delegated.body.sessionId, { status: "idle" });
    registry.updateSession(dispatcherId, { status: "idle" });

    const again = await delegate(dispatcherId, item.id, "second-worker");

    expect(again.status).toBe(403);
    expect(again.body.error).toMatch(/employee "todo-dispatcher" does not own Todo/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
    expect(sessionsOf(item.id, "second-worker")).toHaveLength(0);
  });
});
