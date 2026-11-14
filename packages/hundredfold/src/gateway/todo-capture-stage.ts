/**
 * What a quick capture has actually achieved, derived from facts.
 *
 * A capture moves through six stages, and every one of them is READ rather than
 * written down: the shaping session exists and has spoken, a Todo carries that
 * session as its creator, a Dispatcher is linked to that Todo, a workflow run or
 * a delegated employee is linked to it. Nothing here consults a stored stage
 * string, and that is the point — a written stage drifts from what happened, and
 * cannot survive a gateway restart or a browser reload. A derived one is right
 * by construction, recovers on reload for free, and makes the honesty contract
 * fall out of the shape: if the fact is absent the stage is not claimed, so the
 * UI can never show progress the system has not made.
 *
 * The module is deliberately HTTP-free and takes a plain facts record. The rules
 * are the part worth testing, and they are testable here without a gateway.
 */

/** Ordered. A capture moves forward through the first five, and then settles on
 *  exactly one of three terminals: `routed` (its own Todo is moving), `landed`
 *  (it restated a Todo that already existed) or `failed`. */
export const TODO_CAPTURE_STAGES = ["starting", "shaping", "created", "dispatching", "routed", "landed", "failed"] as const;
export type TodoCaptureStage = (typeof TODO_CAPTURE_STAGES)[number];

export interface TodoCaptureSessionFact {
  id: string;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  /** True once the engine has produced anything at all for this session. */
  spoke: boolean;
  attemptOutcome?: "succeeded" | "failed" | "interrupted" | null;
  lastError?: string | null;
}

export interface TodoCaptureLinkedSessionFact {
  id: string;
  employee: string | null;
}

export interface TodoCaptureTodoFact {
  id: string;
  title: string;
  /** Sessions linked to this Todo, in link order. */
  linked: TodoCaptureLinkedSessionFact[];
}

export interface TodoCaptureFacts {
  captureId: string;
  /** The shaping session, or null once it is gone. */
  session: TodoCaptureSessionFact | null;
  /** Todos whose creator is the shaping session, oldest first. */
  todos: TodoCaptureTodoFact[];
  /** The Todo this capture recorded itself as landing ON — a Todo that already
   *  existed and already covered it. Read from the shaping session's own
   *  work-item link, which `land_on_work_item` is the only thing that writes.
   *  Null when the capture never claimed to restate anything. */
  landedWorkItem: { id: string; title: string } | null;
  /** The employee name the Dispatcher runs as, so a linked Dispatcher is not
   *  mistaken for the delegate it goes on to choose. */
  dispatcherEmployee: string;
  /** The Shaper's own employee name, for the same reason. */
  shaperEmployee: string;
}

export type TodoCaptureRoute =
  | { kind: "employee"; employee: string; sessionId: string };

export interface TodoCaptureState {
  captureId: string;
  sessionId: string | null;
  stage: TodoCaptureStage;
  /** On `landed` this is the Todo the capture landed on, not one it created —
   *  which is the point: the operator is being shown where their sentence went,
   *  and that is the same question either way. */
  workItemId: string | null;
  workItemTitle: string | null;
  routedTo: TodoCaptureRoute | null;
  /** A capture is one Todo. Extras are surfaced rather than hidden, because a
   *  Shaper that minted a board full of items from one sentence is a fact the
   *  operator needs, not one the pipeline should quietly drop. */
  extraWorkItemIds: string[];
  /** Set only on `failed`, and always the real reason. */
  error: string | null;
  /** Why an in-flight capture is parked rather than working — the rate limiter's
   *  own sentence while the Shaper's session is `waiting`. Never a failure: the
   *  gateway retries on its own, so the stage is still true and this only stops
   *  a deliberate sleep from reading as a hang. Null on every other status. */
  waitingReason: string | null;
}

function isOver(session: TodoCaptureSessionFact): boolean {
  return session.status === "idle" || session.status === "error" || session.status === "interrupted";
}

/** A `waiting` session is neither over nor working: the rate limiter parked it
 *  and will resume it. Its `lastError` is that parking notice, so it is read
 *  only while the status still says waiting — on any other status it is a stale
 *  note from a retry that has since gone back to work. */
function waitingReasonOf(session: TodoCaptureSessionFact): string | null {
  if (session.status !== "waiting") return null;
  return session.lastError?.trim() || null;
}

/** The route a Todo took, if it has taken one. The Dispatcher's own session is
 *  not a route — it is the thing that chooses one. */
function routeOf(todo: TodoCaptureTodoFact, facts: TodoCaptureFacts): TodoCaptureRoute | null {
  for (const linked of todo.linked) {
    if (!linked.employee) continue;
    if (linked.employee === facts.dispatcherEmployee || linked.employee === facts.shaperEmployee) continue;
    return { kind: "employee", employee: linked.employee, sessionId: linked.id };
  }
  return null;
}

function hasDispatcher(todo: TodoCaptureTodoFact, dispatcherEmployee: string): boolean {
  return todo.linked.some((linked) => linked.employee === dispatcherEmployee);
}

/** The capture restated something the board already had. Terminal, and a
 *  SUCCESS: the operator's sentence reached the Todo that owns it, which is the
 *  outcome they wanted even though nothing new was created. Reporting it as
 *  `failed` — which is what a missing Todo used to mean — would teach the
 *  operator to distrust a strip that was telling the truth. */
function landed(facts: TodoCaptureFacts, on: { id: string; title: string }): TodoCaptureState {
  return {
    captureId: facts.captureId,
    sessionId: facts.session?.id ?? null,
    stage: "landed",
    workItemId: on.id,
    workItemTitle: on.title,
    routedTo: null,
    extraWorkItemIds: [],
    error: null,
    waitingReason: null,
  };
}

function failed(facts: TodoCaptureFacts, error: string, todo?: TodoCaptureTodoFact): TodoCaptureState {
  return {
    captureId: facts.captureId,
    sessionId: facts.session?.id ?? null,
    stage: "failed",
    workItemId: todo?.id ?? null,
    workItemTitle: todo?.title ?? null,
    routedTo: null,
    extraWorkItemIds: facts.todos.slice(1).map((extra) => extra.id),
    error,
    waitingReason: null,
  };
}

/** The session is over. Whatever it did or did not do, this is terminal, and
 *  the reason is the session's own when it recorded one. */
function terminalReason(session: TodoCaptureSessionFact, todo: TodoCaptureTodoFact | undefined): string {
  const reason = session.lastError?.trim();
  if (!todo) {
    return reason
      ? `the Todo Shaper stopped without creating a Todo: ${reason}`
      : "the Todo Shaper ended its turn without creating a Todo";
  }
  return reason
    ? `Todo ${todo.id} was created but never dispatched: ${reason}`
    : `Todo ${todo.id} was created but the Todo Shaper stopped without dispatching it — check the Todo's comments for the refusal it reported`;
}

/** Before a Todo exists there are only two honest answers: the engine has not
 *  spoken yet, or it has and is working. */
function stageBeforeTodo(session: TodoCaptureSessionFact): TodoCaptureStage {
  return session.spoke ? "shaping" : "starting";
}

/** Once a Todo exists, how far it has got is a question about that Todo. */
function stageAfterTodo(
  todo: TodoCaptureTodoFact,
  facts: TodoCaptureFacts,
): { stage: Exclude<TodoCaptureStage, "failed">; routedTo: TodoCaptureRoute | null } {
  const route = routeOf(todo, facts);
  if (route) return { stage: "routed", routedTo: route };
  if (hasDispatcher(todo, facts.dispatcherEmployee)) return { stage: "dispatching", routedTo: null };
  return { stage: "created", routedTo: null };
}

/** A capture still in motion: the stage it has reached, and the Todo behind it
 *  once there is one. */
function inFlight(
  facts: TodoCaptureFacts,
  session: TodoCaptureSessionFact,
  todo: TodoCaptureTodoFact | undefined,
  progress: { stage: Exclude<TodoCaptureStage, "failed">; routedTo: TodoCaptureRoute | null } | null,
): TodoCaptureState {
  return {
    captureId: facts.captureId,
    sessionId: session.id,
    stage: progress ? progress.stage : stageBeforeTodo(session),
    workItemId: todo ? todo.id : null,
    workItemTitle: todo ? todo.title : null,
    routedTo: progress ? progress.routedTo : null,
    extraWorkItemIds: facts.todos.slice(1).map((extra) => extra.id),
    error: null,
    waitingReason: waitingReasonOf(session),
  };
}

export function deriveTodoCaptureState(facts: TodoCaptureFacts): TodoCaptureState {
  const { session } = facts;
  if (!session) {
    return failed(facts, `the shaping session for capture ${facts.captureId} is gone, so this capture cannot be followed any further`);
  }

  // Checked before anything else about progress, and only when the capture made
  // no Todo of its own: a landing is a statement about a Todo that was already
  // there, so there is no ladder left to climb and nothing later can add to it.
  // A capture that created a Todo AND linked itself somewhere is reported by the
  // created-Todo rules below, because that Todo is the thing still in motion.
  if (facts.todos.length === 0 && facts.landedWorkItem) return landed(facts, facts.landedWorkItem);

  const todo = facts.todos[0];
  const progress = todo ? stageAfterTodo(todo, facts) : null;

  // A capture is terminal when its Shaper has stopped and the Todo is not yet
  // moving. `dispatching` and `routed` are facts about other sessions, and
  // those outlive the Shaper's turn — only `created` and "no Todo at all" are
  // states a stopped Shaper leaves behind for good. Reporting either as still
  // in flight would leave the strip spinning on something that will never move.
  const stalled = progress === null || progress.stage === "created";
  if (isOver(session) && stalled) return failed(facts, terminalReason(session, todo), todo);

  return inFlight(facts, session, todo, progress);
}
