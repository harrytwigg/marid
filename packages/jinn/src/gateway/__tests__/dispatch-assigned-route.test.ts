import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_WALK_STARTED_BY } from "../../board-walk/started-sessions.js";
import {
  assignedTodo,
  delegate,
  delegateEngine,
  dispatch,
  dispatchAs,
  employeeSession,
  registry,
  sessionsOf,
  startDispatchHarness,
  stopDispatchHarness,
  unassignedTodo,
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
  // MAR-163: the operator assigned this Todo and pressed Dispatch by hand, so
  // the assignee binds the Dispatcher. Re-routing it to someone else used to
  // succeed (201); that was the bug — the assignment is the operator's routing
  // choice, and overriding it is the operator's call, not the Dispatcher's.
  it("refuses a manually-dispatched Dispatcher that delegates to anyone but the assignee", async () => {
    const item = assignedTodo("Assigned by the operator, re-routed by Dispatch");

    const dispatched = await dispatch(item.id);
    expect(dispatched.status).toBe(201);
    const dispatcherId = dispatched.body.sessionId as string;
    expect(registry.getSession(dispatcherId)?.employee).toBe("todo-dispatcher");

    const delegated = await delegate(dispatcherId, item.id, "second-worker");

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/binding/);
    expect(delegated.body.error).toContain(item.assignee);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker", status: "executing" });
    expect(sessionsOf(item.id, "second-worker")).toHaveLength(0);
  });

  // An engine-only delegation names nobody, but it still starts execution
  // outside the assignee — so the binding refuses that too.
  it("refuses a bound Dispatcher that delegates to an unnamed engine", async () => {
    const item = assignedTodo("Assigned by the operator, engine-only Dispatch");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const delegated = await delegateEngine(dispatcherId, item.id);

    expect(delegated.status).toBe(403);
    expect(delegated.body.error).toMatch(/binding/);
    expect(delegated.body.error).toContain(item.assignee);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
  });

  // The board walk starts the same Dispatcher with its own routing brief (a
  // reason and an engine preference), so its routing stays its own decision.
  it("still lets a board-walk-started Dispatcher re-route an owned Todo to the employee it picked", async () => {
    const item = assignedTodo("Assigned, started by the board walk");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    registry.updateSession(dispatcherId, { transportMeta: { startedBy: BOARD_WALK_STARTED_BY } });

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

  // No assignee, no binding: the Dispatcher chooses.
  it("lets the Dispatcher choose on a Todo with no assignee", async () => {
    const item = unassignedTodo("Unassigned, routed by Dispatch");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, item.id, "second-worker");

    expect(delegated.status).toBe(201);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "second-worker", status: "executing" });
  });

  // @operator is a person nobody can delegate to, so there is nobody to be bound to: choosing stays open.
  it("lets the Dispatcher choose on a Todo assigned to @operator", async () => {
    const item = assignedTodo("Held by the operator, routed by Dispatch", "@operator");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const delegated = await delegate(dispatcherId, item.id, "second-worker");

    expect(delegated.status).toBe(201);
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
    expect(again.body.error).toMatch(/this Dispatcher's hand-off is spent/);
    expect(workItems.getWorkItem(item.id)).toMatchObject({ assignee: "first-worker" });
    expect(sessionsOf(item.id, "second-worker")).toHaveLength(0);
  });
});

/**
 * A delegate that stopped before finishing: the Dispatcher's one hand-off is
 * spent, so it is refused, as it must be (a fresh start on top of partial work
 * is the operator's call). The refusal used to stop there, which left the
 * Dispatcher reaching for a second session that had no standing either. It now
 * names the recovery that keeps the work, resuming the delegate's own session,
 * and the operator action that starts afresh.
 */
describe("a Dispatcher whose delegate stopped", () => {
  async function crashedHandoff(title: string) {
    const item = assignedTodo(title);
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const delegated = await delegate(dispatcherId, item.id, "first-worker");
    expect(delegated.status).toBe(201);
    const delegateId = delegated.body.sessionId as string;
    registry.updateSession(delegateId, { status: "error", lastError: "lost the engine's event stream" });
    registry.updateSession(dispatcherId, { status: "idle" });
    return { item, dispatcherId, delegateId };
  }

  it("is refused a second delegation, with the delegate session to resume and the operator's fresh start", async () => {
    const { item, dispatcherId, delegateId } = await crashedHandoff("Delegate crashed mid-work");

    const again = await delegate(dispatcherId, item.id, "first-worker");

    expect(again.status).toBe(403);
    expect(again.body.error).toContain("hand-off is spent");
    expect(again.body.error).toContain(`send_to_session { sessionId: "${delegateId}" }`);
    expect(again.body.error).toMatch(/first-worker, error/);
    expect(again.body.error).toContain(`press Dispatch on Todo ${item.id}`);
    expect(sessionsOf(item.id, "first-worker")).toHaveLength(1);
  });

  // Before the hand-off the Dispatcher may still delegate, so a refusal of some
  // other action must not read as spent: that would send it to block a Todo it
  // could route.
  it("tells a Dispatcher that has not handed off yet to delegate, not that it is spent", async () => {
    const item = assignedTodo("Dispatcher calls dispatch before delegating");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;

    const refused = await dispatchAs(dispatcherId, item.id);

    expect(refused.status).toBe(403);
    expect(refused.body.error).not.toMatch(/spent/);
    expect(refused.body.error).toContain(`delegate_task { workItemId: "${item.id}" }`);
    expect((await delegate(dispatcherId, item.id, "first-worker")).status).toBe(201);
  });

  it("gets the same guidance from dispatch_work_item, and starts no second Dispatcher", async () => {
    const { item, dispatcherId, delegateId } = await crashedHandoff("Delegate crashed, Dispatcher tries dispatch");

    const again = await dispatchAs(dispatcherId, item.id);

    expect(again.status).toBe(403);
    expect(again.body.error).toContain(`send_to_session { sessionId: "${delegateId}" }`);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
  });

  it("still lets the operator's Dispatch start afresh, and that Dispatcher hand the Todo on", async () => {
    const { item, dispatcherId } = await crashedHandoff("Delegate crashed, operator presses Dispatch");

    const pressed = await dispatch(item.id);

    expect(pressed.status).toBe(201);
    const fresh = pressed.body.sessionId as string;
    expect(fresh).not.toBe(dispatcherId);
    const delegated = await delegate(fresh, item.id, "first-worker");
    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ employee: "first-worker", parentSessionId: fresh });
  });

  // The other half of the incident: a child spawned with no employee (or, before
  // the spawn route refused it, as the operator's coordinator) has no standing.
  it("refuses an employee-less child, saying who can act on the Todo", async () => {
    const { item, dispatcherId } = await crashedHandoff("Delegate crashed, a plain child tries");
    const child = registry.createSession({
      engine: "codex", source: "web", sourceRef: "plain-child:1", connector: "web", prompt: "delegate it", parentSessionId: dispatcherId,
    });

    const attempted = await delegate(child.id, item.id, "first-worker");

    expect(attempted.status).toBe(403);
    expect(attempted.body.error).toMatch(/has no employee identity and cannot delegate Todo/);
    expect(attempted.body.error).toMatch(/owner, their manager or the operator/);
  });
});
