import { getMessages, getSession, listSessionsByWorkItem } from "../sessions/registry.js";
import { getWorkItem, listWorkItems } from "../work-items/store.js";
import { logger } from "../shared/logger.js";
import { sourceSessionId } from "./approval-authority.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "./system-employees.js";
import { deriveTodoCaptureState, type TodoCaptureFacts, type TodoCaptureState, type TodoCaptureTodoFact } from "./todo-capture-stage.js";
import type { ApiContext } from "./api.js";

/**
 * What is TRUE about a capture right now, read straight out of the registry.
 *
 * This is the half of quick capture that answers "how far has it got", and it
 * is deliberately separate from the routes that serve that answer: the routes
 * are about HTTP, and this is about provenance — which session shaped the
 * capture, which Todos it made, what is linked to them, and where it landed if
 * it landed. `deriveTodoCaptureState` turns those facts into a stage; nothing
 * here decides one.
 */

/** Last stage pushed for a capture, so an unchanged recompute stays quiet.
 *  Bounded by the captures a running gateway has seen; a restart clears it and
 *  the next GET re-pushes, which is the correct behaviour rather than a leak. */
const lastEmitted = new Map<string, string>();

/**
 * The Todo a capture landed ON, if it landed anywhere.
 *
 * A capture that restated an existing Todo creates nothing, so there is no Todo
 * of its own to read. What it leaves instead is a link from its OWN session to
 * the Todo it restated — one field on the session object the caller already
 * holds. `land_on_work_item` is the only thing that writes it on a shaping
 * session, which is what makes reading it a fact rather than a guess about what
 * the Shaper's comment meant.
 *
 * Todos the capture created itself are excluded: those are answered by the
 * ladder, and a capture linked to its own Todo has not restated anything.
 */
function landedWorkItem(
  session: ReturnType<typeof getSession>,
  created: readonly { id: string }[],
): { id: string; title: string } | null {
  const landedId = session?.workItemId;
  if (!landedId || created.some((item) => item.id === landedId)) return null;
  const item = getWorkItem(landedId);
  return item ? { id: item.id, title: item.title } : null;
}
function factsFor(captureId: string, dispatcherEmployee: string, shaperEmployee: string): TodoCaptureFacts {
  const session = getSession(captureId);
  // Narrow in SQL to Todos this employee made from a session, then match the
  // exact capture on provenance. `createdBy` records the EMPLOYEE, so it cannot
  // tell two captures apart — `sourceRef` names the session, and is the same
  // link the dispatch authority walk reads.
  //
  // `listWorkItems` orders for the board, not by age. The capture's Todo is the
  // FIRST one its session made, so age is what this needs.
  const todos = listWorkItems({ source: "session", createdBy: shaperEmployee })
    .filter((item) => sourceSessionId(item) === captureId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return {
    captureId,
    landedWorkItem: landedWorkItem(session, todos),
    session: session
      ? {
        id: session.id,
        status: session.status,
        // "The engine has said something" is the only honest difference between
        // a session that has started and one that is working.
        spoke: getMessages(session.id).some((message) => message.role === "assistant"),
        attemptOutcome: session.attemptOutcome ?? null,
        lastError: session.lastError ?? null,
      }
      : null,
    todos: todos.map((item): TodoCaptureTodoFact => ({
      id: item.id,
      title: item.title,
      linked: listSessionsByWorkItem(item.id).map((linked) => ({
        id: linked.id,
        employee: linked.employee,
      })),
    })),
    dispatcherEmployee,
    shaperEmployee,
  };
}

/** Derive, and push only when the answer moved. The GET stays the source of
 *  truth; this event only saves the browser from polling for a change that has
 *  not happened yet.
 *
 *  A failure is written to the log from inside that same guard, and for the same
 *  reason `refuse` above writes one: a reason that only ever existed in an HTTP
 *  response is gone the moment the tab closes. It belongs in the guard rather
 *  than beside it because a strip left open re-reads on every frame, and the
 *  guard is precisely the "this answer is new" test that keeps one failure to
 *  one line. A failure is DERIVED, never thrown, so no throw site can log it. */
export function refreshTodoCapture(context: ApiContext, captureId: string): TodoCaptureState {
  const state = deriveTodoCaptureState(factsFor(captureId, TODO_DISPATCHER_NAME, TODO_SHAPER_NAME));
  const signature = `${state.stage}:${state.workItemId ?? ""}:${state.error ?? ""}`;
  if (lastEmitted.get(captureId) !== signature) {
    lastEmitted.set(captureId, signature);
    if (state.stage === "failed") {
      logger.warn(`Quick capture ${captureId} failed: ${state.error}`);
    }
    context.emit("todo-capture:stage", {
      captureId,
      stage: state.stage,
      workItemId: state.workItemId,
    });
  }
  return state;
}
