import { describe, expect, it } from "vitest";
import {
  deriveTodoCaptureState,
  type TodoCaptureFacts,
  type TodoCaptureLinkedSessionFact,
  type TodoCaptureSessionFact,
  type TodoCaptureTodoFact,
} from "../todo-capture-stage.js";

/**
 * The rules a capture's progress is read by. Each case fixes one fact and
 * asserts the stage that fact — and only that fact — earns.
 */

function session(over: Partial<TodoCaptureSessionFact> = {}): TodoCaptureSessionFact {
  return { id: "shaper-1", status: "running", spoke: true, ...over };
}

function todo(over: Partial<TodoCaptureTodoFact> = {}): TodoCaptureTodoFact {
  return { id: "PLA-9", title: "Closed rail scrolls under the board header", linked: [], ...over };
}

function facts(over: Partial<TodoCaptureFacts> = {}): TodoCaptureFacts {
  return {
    captureId: "shaper-1",
    session: session(),
    todos: [],
    landedWorkItem: null,
    dispatcherEmployee: "todo-dispatcher",
    shaperEmployee: "todo-shaper",
    ...over,
  };
}

const dispatcher: TodoCaptureLinkedSessionFact = { id: "disp-1", employee: "todo-dispatcher" };

describe("deriveTodoCaptureState — the forward path", () => {
  it("is starting while the session is running and the engine has not spoken", () => {
    const state = deriveTodoCaptureState(facts({ session: session({ spoke: false }) }));

    expect(state).toMatchObject({ stage: "starting", sessionId: "shaper-1", workItemId: null, error: null });
  });

  it("is shaping once the engine has spoken but no Todo exists yet", () => {
    expect(deriveTodoCaptureState(facts()).stage).toBe("shaping");
  });

  // A rate-limited Shaper is parked, not broken: the gateway will retry it on
  // its own. The stage stays honest — nothing has happened yet — but a bare
  // spinner for a session that is deliberately asleep reads as a hang, so the
  // reason it is asleep rides along beside it.
  it("carries why a waiting Shaper is waiting, without calling the capture over", () => {
    const state = deriveTodoCaptureState(facts({
      session: session({ status: "waiting", spoke: false, lastError: "Codex usage limit — resumes 2026-08-24T12:00:00.000Z" }),
    }));

    expect(state).toMatchObject({
      stage: "starting",
      error: null,
      waitingReason: "Codex usage limit — resumes 2026-08-24T12:00:00.000Z",
    });
  });

  it("carries no waiting reason while the Shaper is simply running", () => {
    expect(deriveTodoCaptureState(facts()).waitingReason).toBeNull();
  });

  // The reason belongs to `waiting` alone. A stale one from an earlier retry
  // would otherwise sit under a session that has since gone back to work.
  it("drops the waiting reason once the Shaper is running again", () => {
    const state = deriveTodoCaptureState(facts({
      session: session({ status: "running", lastError: "Codex usage limit — resumes 2026-08-24T12:00:00.000Z" }),
    }));

    expect(state.waitingReason).toBeNull();
  });

  it("is created once a Todo names the session as its creator, and carries the Todo", () => {
    const state = deriveTodoCaptureState(facts({ todos: [todo()] }));

    expect(state).toMatchObject({
      stage: "created",
      workItemId: "PLA-9",
      workItemTitle: "Closed rail scrolls under the board header",
      routedTo: null,
    });
  });

  it("is dispatching once a Dispatcher session is linked to that Todo", () => {
    const state = deriveTodoCaptureState(facts({ todos: [todo({ linked: [dispatcher] })] }));

    expect(state).toMatchObject({ stage: "dispatching", workItemId: "PLA-9", routedTo: null });
  });

  it("is routed, naming the employee, once a delegate is linked", () => {
    const state = deriveTodoCaptureState(facts({
      todos: [todo({ linked: [dispatcher, { id: "worker-1", employee: "route-worker" }] })],
    }));

    expect(state).toMatchObject({ stage: "routed", routedTo: { kind: "employee", employee: "route-worker", sessionId: "worker-1" } });
  });

  // The Dispatcher chooses a route; it is not one. Counting it as the delegate
  // would report every Todo as routed the instant dispatch started.
  it("does not mistake the Dispatcher's own session for the delegate it picks", () => {
    expect(deriveTodoCaptureState(facts({ todos: [todo({ linked: [dispatcher] })] })).routedTo).toBeNull();
  });

  it("does not mistake the Shaper's own linked session for a delegate", () => {
    const state = deriveTodoCaptureState(facts({
      todos: [todo({ linked: [{ id: "shaper-1", employee: "todo-shaper" }] })],
    }));

    expect(state).toMatchObject({ stage: "created", routedTo: null });
  });
});

describe("deriveTodoCaptureState — the failure edges", () => {
  it("fails when the shaping session is gone", () => {
    const state = deriveTodoCaptureState(facts({ session: null }));

    expect(state.stage).toBe("failed");
    expect(state.error).toMatch(/gone/);
    expect(state.sessionId).toBeNull();
  });

  it("fails with the session's own reason when it died before creating a Todo", () => {
    const state = deriveTodoCaptureState(facts({
      session: session({ status: "error", spoke: true, lastError: 'engine "codex" exited with code 1' }),
    }));

    expect(state.stage).toBe("failed");
    expect(state.error).toContain('engine "codex" exited with code 1');
  });

  it("still fails honestly when the session ended with no reason recorded", () => {
    const state = deriveTodoCaptureState(facts({ session: session({ status: "idle", lastError: null }) }));

    expect(state).toMatchObject({ stage: "failed", workItemId: null });
    expect(state.error).toMatch(/without creating a Todo/);
  });

  // What a refused claim looks like from outside: the Todo is real, the Shaper
  // reported the refusal in a comment and stopped, and nothing is running it.
  it("fails, keeping the Todo, when it was created but the Shaper stopped without dispatching", () => {
    const state = deriveTodoCaptureState(facts({
      session: session({ status: "idle" }),
      todos: [todo()],
    }));

    expect(state).toMatchObject({ stage: "failed", workItemId: "PLA-9" });
    expect(state.error).toMatch(/never dispatched|without dispatching/);
  });

  it("quotes the session's reason when a created Todo was never dispatched", () => {
    const state = deriveTodoCaptureState(facts({
      session: session({ status: "error", lastError: "Todo PLA-9 is already being dispatched by session s-earlier" }),
      todos: [todo()],
    }));

    expect(state.error).toContain("already being dispatched by session s-earlier");
  });

  // An interrupted Shaper is over, not pausing. Treating it as still shaping
  // would leave the strip spinning on a session that will never move again.
  it("treats an interrupted session as over rather than in flight", () => {
    expect(deriveTodoCaptureState(facts({ session: session({ status: "interrupted" }) })).stage).toBe("failed");
  });

  // A Todo created and not yet handed off is not a failure while the Shaper is
  // still on its turn — that is simply the gap between the two calls.
  it("stays on created while the Shaper is still running", () => {
    expect(deriveTodoCaptureState(facts({ session: session({ status: "running" }), todos: [todo()] })).stage).toBe("created");
  });

  it("reports the first Todo and surfaces the extras when one capture made several", () => {
    const state = deriveTodoCaptureState(facts({
      todos: [todo(), todo({ id: "PLA-10" }), todo({ id: "PLA-11" })],
    }));

    expect(state).toMatchObject({ workItemId: "PLA-9", extraWorkItemIds: ["PLA-10", "PLA-11"] });
  });

  it("surfaces extras on a failure too, so nothing a capture made is hidden", () => {
    const state = deriveTodoCaptureState(facts({ session: null, todos: [todo(), todo({ id: "PLA-10" })] }));

    expect(state).toMatchObject({ stage: "failed", extraWorkItemIds: ["PLA-10"] });
  });
});

/**
 * A dedupe is an outcome, not a breakdown. These two describe the seam between
 * them: a capture that recorded where it landed is terminal and fine, and a
 * capture that recorded nothing is terminal and broken — and the fix for the
 * first must not reach the second.
 */
describe("deriveTodoCaptureState — landing on a Todo that already existed", () => {
  const existing = { id: "PLA-4", title: "Collapsed rail scrolls under the header" };

  it("is landed, naming that Todo, once the capture records where it went", () => {
    const state = deriveTodoCaptureState(facts({ landedWorkItem: existing }));

    expect(state).toMatchObject({
      stage: "landed",
      workItemId: "PLA-4",
      workItemTitle: "Collapsed rail scrolls under the header",
      routedTo: null,
      error: null,
    });
  });

  it("stays landed after the Shaper's turn ends, because the landing is the whole outcome", () => {
    const over = facts({ landedWorkItem: existing, session: session({ status: "idle" }) });

    expect(deriveTodoCaptureState(over).stage).toBe("landed");
  });

  it("does not report a landing as failed even when the session recorded an error", () => {
    const over = facts({ landedWorkItem: existing, session: session({ status: "error", lastError: "engine died" }) });

    expect(deriveTodoCaptureState(over)).toMatchObject({ stage: "landed", error: null });
  });

  it("prefers the Todo the capture CREATED when it somehow did both", () => {
    const over = facts({ todos: [todo()], landedWorkItem: existing });

    expect(deriveTodoCaptureState(over)).toMatchObject({ stage: "created", workItemId: "PLA-9" });
  });

  // The direction the fix must not turn green. A Shaper that died having
  // created nothing AND landed nowhere is still a failure, and still has to say
  // why in the gateway's own words.
  it("still fails, with the real reason, when the session ended having recorded nothing at all", () => {
    const over = facts({ session: session({ status: "error", lastError: "engine not available" }) });

    expect(deriveTodoCaptureState(over)).toMatchObject({
      stage: "failed",
      workItemId: null,
      error: "the Todo Shaper stopped without creating a Todo: engine not available",
    });
  });
});
