import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignedTodo,
  delegate,
  dispatch,
  linkedAttempt,
  registry,
  sessionsOf,
  startDispatchHarness,
  stopDispatchHarness,
  workItems,
} from "./dispatch-assigned-harness.js";

/**
 * Dispatch on a Todo that is already being executed.
 *
 * Dispatch starts work; it never starts a second attempt beside one already
 * running, and when it refuses it does so at click time, before any
 * Dispatcher exists, rather than late inside the Dispatcher's session. A Todo
 * whose only linked attempt is an earlier Dispatcher is the stranded case the
 * button has to be able to restart.
 */

beforeAll(startDispatchHarness);
afterAll(stopDispatchHarness);

describe("Dispatch on a Todo that is already executing", () => {
  it("refuses at click time while an execution attempt is in flight, without starting a Dispatcher", async () => {
    const item = assignedTodo("Being worked right now");
    // Linked without a claim, the way cron and talk start work.
    const worker = linkedAttempt(item.id, "first-worker", "running", "worker:live");
    const sessionsBefore = registry.countSessions();

    const response = await dispatch(item.id);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", workItemId: item.id, sessionId: worker.id });
    expect(response.body.error).toMatch(/already being worked by first-worker/);
    expect(registry.countSessions()).toBe(sessionsBefore);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(0);
  });

  it("refuses when the assignee's attempt is idle between turns, pointing at that session", async () => {
    const item = workItems.createWorkItem({
      title: "Producer waiting on review", source: "human", status: "executing", assignee: "first-worker", department: "platform",
    });
    const producer = linkedAttempt(item.id, "first-worker", "idle", "worker:idle");
    const sessionsBefore = registry.countSessions();

    const response = await dispatch(item.id);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", sessionId: producer.id });
    expect(response.body.error).toMatch(/idle between turns/);
    expect(registry.countSessions()).toBe(sessionsBefore);
  });

  // The stranded shape the bug report came from: the only execute link is an
  // earlier Dispatcher's, which routes and never works. Dispatch is the way out.
  it("restarts a Todo whose only linked attempt is an earlier Dispatcher, and the new one can delegate", async () => {
    const item = assignedTodo("Left executing by a Dispatcher that stopped");
    const first = await dispatch(item.id);
    registry.updateSession(first.body.sessionId, { status: "idle" });
    const { releaseWorkItemClaimForSession } = await import("../../work-items/claims.js");
    releaseWorkItemClaimForSession(first.body.sessionId);
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");

    const again = await dispatch(item.id);

    expect(again.status).toBe(201);
    expect(again.body.sessionId).not.toBe(first.body.sessionId);
    expect((await delegate(again.body.sessionId, item.id, "first-worker")).status).toBe(201);
  });

  it("lets Dispatch start a reassigned Todo whose idle attempt belongs to the previous assignee", async () => {
    const item = workItems.createWorkItem({
      title: "Handed to someone new", source: "human", status: "executing", assignee: "second-worker", department: "platform",
    });
    linkedAttempt(item.id, "first-worker", "idle", "worker:previous");

    const response = await dispatch(item.id);

    expect(response.status).toBe(201);
    expect(registry.getSession(response.body.sessionId)?.employee).toBe("todo-dispatcher");
  });

  // The Dispatcher's own execute link must not let it, or a second Dispatcher,
  // run beside the employee it handed the Todo to.
  it("after the hand-off, refuses a second Dispatch while the delegate works instead of reusing the Dispatcher", async () => {
    const item = assignedTodo("Handed off and in progress");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const delegated = await delegate(dispatcherId, item.id, "first-worker");
    expect(delegated.status).toBe(201);

    const again = await dispatch(item.id);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "TODO_ALREADY_EXECUTING", sessionId: delegated.body.sessionId });
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
    expect(sessionsOf(item.id, "first-worker")).toHaveLength(1);

    // Nor can the Dispatcher hand it on a second time: its standing ended at the hand-off.
    const twice = await delegate(dispatcherId, item.id, "second-worker");
    expect(twice.status).toBe(403);
    expect(sessionsOf(item.id, "second-worker")).toHaveLength(0);
  });
});
