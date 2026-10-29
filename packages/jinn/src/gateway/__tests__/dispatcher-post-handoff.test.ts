import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyParentSessionAndWait } from "../../sessions/callbacks.js";
import { recordRefusedBeforeEngine } from "../../sessions/engine-reach.js";
import {
  assignedTodo,
  delegate,
  dispatch,
  dispatchAs,
  employeeSession,
  messageAs,
  registry,
  sessionsOf,
  startDispatchHarness,
  stopDispatchHarness,
  workItems,
} from "./dispatch-assigned-harness.js";

/**
 * Once the Todo Dispatcher has handed a Todo on it is done with it. The
 * operator may be settling the Todo with the delegate in chat, and a
 * Dispatcher woken by each of the delegate's replies, free to message it or
 * dispatch again, cuts across what they agreed. These tests pin that the
 * gateway wakes it for nothing, lets it message nobody, and still starts a
 * fresh Dispatcher when the operator presses Dispatch.
 */

beforeAll(startDispatchHarness);
afterAll(stopDispatchHarness);

/** A Todo dispatched and handed to its assignee, both sessions idle. */
async function handedOff(title: string) {
  const item = assignedTodo(title);
  const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
  const delegated = await delegate(dispatcherId, item.id, "first-worker");
  expect(delegated.status).toBe(201);
  const delegateId = delegated.body.sessionId as string;
  registry.updateSession(delegateId, { status: "idle" });
  registry.updateSession(dispatcherId, { status: "idle" });
  return { item, dispatcherId, delegateId };
}

const deliveriesTo = (sessionId: string) =>
  registry.listPendingSessionDeliveries().filter((delivery) => delivery.targetSessionId === sessionId);

const userMessages = (sessionId: string) =>
  registry.getMessages(sessionId).filter((message) => message.role !== "assistant");

describe("a Dispatcher that has handed its Todo on", () => {
  it("is not woken by the delegate's replies, however many the operator's chat produces", async () => {
    const { dispatcherId, delegateId } = await handedOff("Operator chats with the delegate after the hand-off");
    const delegateSession = registry.getSession(delegateId)!;

    await notifyParentSessionAndWait(delegateSession, { result: "Agreed with the operator: keep the current approach." });
    await notifyParentSessionAndWait(delegateSession, { result: "Done." }, { alwaysNotify: true });

    expect(deliveriesTo(dispatcherId)).toHaveLength(0);
  });

  it("is not woken by the delegate's rate-limit notices either", async () => {
    const { dispatcherId, delegateId } = await handedOff("Delegate rate-limited after the hand-off");
    const { notifyRateLimitResumed } = await import("../../sessions/callbacks.js");

    notifyRateLimitResumed(registry.getSession(delegateId)!);

    expect(deliveriesTo(dispatcherId)).toHaveLength(0);
  });

  it("may not message the delegate, and the delegate's session gets nothing", async () => {
    const { dispatcherId, delegateId } = await handedOff("Dispatcher tries to steer the delegate");
    const before = userMessages(delegateId).length;

    const sent = await messageAs(dispatcherId, delegateId, "Carry on, but use a different approach.");

    expect(sent.status).toBe(403);
    expect(sent.body.error).toMatch(/already handed its Todo on/);
    expect(userMessages(delegateId)).toHaveLength(before);
  });

  it("may not message any other session either", async () => {
    const { dispatcherId } = await handedOff("Dispatcher tries to reach somebody else");
    const bystander = employeeSession("second-worker", "bystander:1");

    const sent = await messageAs(dispatcherId, bystander.id, "Please look at this.");

    expect(sent.status).toBe(403);
    expect(registry.getMessages(bystander.id).filter((message) => message.role === "notification")).toHaveLength(0);
  });

  it("may not dispatch or delegate the Todo again", async () => {
    const { item, dispatcherId } = await handedOff("Dispatcher tries to start the Todo again");

    const dispatched = await dispatchAs(dispatcherId, item.id);
    const delegated = await delegate(dispatcherId, item.id, "first-worker");

    expect(dispatched.status).toBe(403);
    expect(delegated.status).toBe(403);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
    expect(sessionsOf(item.id, "first-worker")).toHaveLength(1);
  });

  it("stays quiet when the delegate errored mid-work: the operator restarts it, not the Dispatcher", async () => {
    const { item, dispatcherId, delegateId } = await handedOff("Delegate crashed after the hand-off");
    registry.updateSession(delegateId, { status: "error", lastError: "lost the engine's event stream" });

    await notifyParentSessionAndWait(registry.getSession(delegateId)!, { error: "lost the engine's event stream" });
    const sent = await messageAs(dispatcherId, delegateId, "Try again.");

    expect(deliveriesTo(dispatcherId)).toHaveLength(0);
    expect(sent.status).toBe(403);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
  });

  it("still lets the operator press Dispatch afresh, and that new Dispatcher hands the Todo on", async () => {
    const { item, dispatcherId, delegateId } = await handedOff("Operator redispatches after the delegate stopped");
    registry.updateSession(delegateId, { status: "error", lastError: "lost the engine's event stream" });

    const pressed = await dispatch(item.id);

    expect(pressed.status).toBe(201);
    const fresh = pressed.body.sessionId as string;
    expect(fresh).not.toBe(dispatcherId);
    expect((await delegate(fresh, item.id, "first-worker")).status).toBe(201);
    expect(sessionsOf(item.id, "first-worker")).toHaveLength(2);
    // The old Dispatcher stays out of it.
    expect((await messageAs(dispatcherId, delegateId, "Carry on.")).status).toBe(403);
  });

  it("does not let a second Dispatch start a second attempt over a live delegate", async () => {
    const { item, delegateId } = await handedOff("Operator presses Dispatch while the delegate works");
    registry.updateSession(delegateId, { status: "running" });

    const pressed = await dispatch(item.id);

    expect(pressed.status).toBe(409);
    expect(sessionsOf(item.id, "todo-dispatcher")).toHaveLength(1);
  });
});

describe("a Dispatcher whose hand-off has not happened or never started", () => {
  it("is still woken by a delegate refused before its engine ran, since it may retry once", async () => {
    const item = assignedTodo("Delegate refused before its engine started");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const delegated = await delegate(dispatcherId, item.id, "first-worker");
    const delegateId = delegated.body.sessionId as string;
    registry.updateSession(delegateId, { status: "error", lastError: "engine refused" });
    recordRefusedBeforeEngine(delegateId);
    registry.updateSession(dispatcherId, { status: "idle" });

    await notifyParentSessionAndWait(registry.getSession(delegateId)!, { error: "engine refused" });

    expect(deliveriesTo(dispatcherId).length).toBeGreaterThan(0);
  });

  it("is not stopped from messaging before it has delegated", async () => {
    const item = assignedTodo("Dispatcher has not delegated yet");
    const dispatcherId = (await dispatch(item.id)).body.sessionId as string;
    const bystander = employeeSession("second-worker", "bystander:2");

    const sent = await messageAs(dispatcherId, bystander.id, "Question before routing.");

    expect(sent.body?.error ?? "").not.toMatch(/already handed its Todo on/);
    expect(workItems.getWorkItem(item.id)?.assignee).toBe("first-worker");
  });
});
