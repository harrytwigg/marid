import type { Database as DatabaseType } from "better-sqlite3";
import { OPERATOR_ASSIGNEE } from "./operator-assignee.js";
import type { AppendWorkItemEventInput, WorkItem } from "./store.js";
import { clearTodoPerson, storedTodoPerson, writeTodoPerson } from "./todo-people.js";

/**
 * How the person responsible and the agent move together.
 *
 * The operator as the person is stored the way "needs the operator" always was, so every reader of `assignee` (the
 * attention lane, backlog dispatch, quiet-watch, the review addressee) keeps meaning what it meant:
 *
 *  - person `@operator`, no agent: `assignee = '@operator'`, no `todo_people` row (the invariant: an `@operator`
 *    assignee never has an `@operator` row, which would be redundant; it may have a person's row, see below);
 *  - person `@operator`, agent X: `assignee = X` and the row `@operator` (the agent owns execution);
 *  - any other person: the row, and `assignee` is whatever the agent is.
 *
 * Setting an agent while `assignee` is `@operator` keeps the operator as the person (the row appears). Clearing the agent
 * while the row is `@operator` hands the Todo back to the operator (`assignee = '@operator'`, row gone), so it needs them
 * again. Clearing the person while `assignee` is `@operator` with no row clears that assignee. Naming a user while
 * `assignee` is `@operator` clears it too, with or without a user's row beside it: naming someone else hands the Todo on,
 * and the `person_changed` event records `assigneeCleared`.
 *
 * An assignment to the operator (an agent handing the Todo over, say) never changes a person that is a user: the row
 * stays beside `assignee = '@operator'`, which then reads as "needs the operator" in the agent slot. Only the operator
 * moves the person, so no agent can change a field that agents may not set. Clearing the person in that state drops the
 * row and leaves the operator as the person (the Todo still waits on them; clearing again clears the assignee as above).
 */

export interface OwnershipInput {
  /** The agent slot: undefined leaves it, null clears it. */
  assignee?: string | null;
  /** The person slot: undefined leaves it, null clears it. */
  humanAssignee?: string | null;
}

export interface OwnershipPlan {
  /** What `work_items.assignee` holds afterwards. */
  assignee: string | null;
  /** What `todo_people` holds afterwards (null: no row). */
  person: string | null;
  /** The person as read before and after (the row, else the operator when `assignee` is). */
  from: string | null;
  to: string | null;
  /** The person slot moved `assignee` (not the agent slot): a clear, or the operator chosen with no agent. */
  assigneeMovedByPerson: boolean;
  /** The agent slot moved the person as read: clearing an `@operator` assignee with no row, which is the operator as the person. */
  personMovedByAgent: boolean;
}

const effective = (assignee: string | null, person: string | null): string | null =>
  person ?? (assignee === OPERATOR_ASSIGNEE ? OPERATOR_ASSIGNEE : null);

/** The agent slot's rules, on the pair as it stands. */
function moveAgent(agent: string | null, person: string | null, next: string | null): { agent: string | null; person: string | null } {
  if (next === null) return person === OPERATOR_ASSIGNEE ? { agent: OPERATOR_ASSIGNEE, person: null } : { agent: null, person };
  if (next === OPERATOR_ASSIGNEE) return { agent: OPERATOR_ASSIGNEE, person: person === OPERATOR_ASSIGNEE ? null : person };
  return { agent: next, person: agent === OPERATOR_ASSIGNEE && person === null ? OPERATOR_ASSIGNEE : person };
}

/** The person slot's rules, on the pair as it stands. */
function movePerson(agent: string | null, person: string | null, next: string | null): { agent: string | null; person: string | null } {
  if (next === effective(agent, person)) return { agent, person };
  if (next === null) return person !== null ? { agent, person: null } : { agent: null, person: null };
  if (next === OPERATOR_ASSIGNEE) return agent === null || agent === OPERATOR_ASSIGNEE ? { agent: OPERATOR_ASSIGNEE, person: null } : { agent, person: OPERATOR_ASSIGNEE };
  // Naming a user hands a Todo that waits on the operator on: `@operator` leaves the agent slot, with or without a user's
  // row beside it, and the event says so (`assigneeCleared`). Only the operator can do this; a member's route refuses it.
  return { agent: agent === OPERATOR_ASSIGNEE ? null : agent, person: next };
}

/** Pure: where the two slots land for an edit of either. */
export function planOwnership(current: Pick<WorkItem, "assignee">, storedPerson: string | null, input: OwnershipInput): OwnershipPlan {
  const from = effective(current.assignee, storedPerson);
  let pair = { agent: current.assignee, person: storedPerson };
  if (input.assignee !== undefined && input.assignee !== current.assignee) pair = moveAgent(pair.agent, pair.person, input.assignee);
  const afterAgent = pair.agent;
  const personMovedByAgent = effective(pair.agent, pair.person) !== from;
  if (input.humanAssignee !== undefined) pair = movePerson(pair.agent, pair.person, input.humanAssignee);
  return { assignee: pair.agent, person: pair.person, from, to: effective(pair.agent, pair.person), assigneeMovedByPerson: pair.agent !== afterAgent, personMovedByAgent };
}

/**
 * The `person_changed` detail for a plan: the person as read before and after, plus what the edit cleared in the slot it
 * did not name, so no write clears a slot silently. `assigneeCleared`: the person slot took the operator out of
 * `assignee`. `personCleared`: the agent slot cleared the person, which happens only when an `@operator` assignee with no
 * row (the operator as the person, by storage) is cleared; every other agent edit leaves the person as read alone (the
 * ownership tests prove both over every state).
 */
export function personChangedDetail(plan: OwnershipPlan): { from: string | null; to: string | null; assigneeCleared?: true; personCleared?: true } {
  return {
    from: plan.from,
    to: plan.to,
    ...(plan.assigneeMovedByPerson && plan.assignee === null ? { assigneeCleared: true as const } : {}),
    ...(plan.personMovedByAgent && plan.to === null ? { personCleared: true as const } : {}),
  };
}

/** Who writes and how, with what the writes need from the store (passed in because the store imports this module). */
export interface PersonWrite {
  actor: string;
  /** `state` advances the Todo's version with the event; `companion` rides a row update that already did. */
  effect: "state" | "companion";
  append: (input: AppendWorkItemEventInput) => unknown;
}

/**
 * Store the plan's person row and, when the person as read changed, the `person_changed` event. Never touches
 * `work_items`: the caller writes `plan.assignee` in its own UPDATE, so the agent slot keeps one writer. The event is
 * `person_changed` and never `metadata_edited`, which a board hook reads; a person change fires no hook, wakes and
 * dispatches nothing.
 */
export function writeOwnership(db: DatabaseType, current: Pick<WorkItem, "id">, plan: OwnershipPlan, write: PersonWrite): boolean {
  if (plan.person === null) clearTodoPerson(db, current.id);
  else if (plan.person !== storedTodoPerson(db, current.id)) writeTodoPerson(db, current.id, plan.person, write.actor, new Date().toISOString());
  if (plan.from === plan.to) return false;
  write.append({
    workItemId: current.id,
    kind: "person_changed",
    actor: write.actor,
    detail: personChangedDetail(plan),
    versionEffect: write.effect,
  });
  return true;
}
