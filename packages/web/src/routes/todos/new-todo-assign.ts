import { api } from "@/lib/api"
import { newTodoEditRequest } from "./todo-edit-request"
import { OPERATOR_ASSIGNEE } from "./util"

/** Who a new Todo is created for: the agent who does the work and the person responsible, either or both. */
export interface CreateAssignees {
  assignee: string | null
  person: string | null
}

/** The slots a create could not fill once the Todo existed, so the dialog can name every one left unset. */
export class AssignOnCreateError extends Error {
  constructor(readonly slots: Array<"agent" | "person">) {
    super(`could not set the ${slots.join(" and ")}`)
  }
}

/**
 * Make the choices the create dialog collected, once the Todo exists. Yourself with no agent is the create-assigned-to-you
 * the dialog always offered: the assign route, which stores `@operator`. Anything else names the agent through the assign route
 * and the person through the pen, the same two lanes the Todo page uses, so neither slot disturbs the other. A board member
 * is named before the agent: an agent from another board moves the Todo there, and the member is named on the board the
 * draft chose (the person row then stays through the move, as it does on the Todo page). The operator as the person goes
 * after the agent, which keeps them beside it instead of making the Todo wait on them first. Each slot is tried whatever
 * happened to the other, and every slot left unset is named, so no choice is dropped without a word.
 */
export async function assignOnCreate(created: { id: string; version?: number }, { assignee, person }: CreateAssignees): Promise<void> {
  const failed: Array<"agent" | "person"> = []
  const attempt = async (slot: "agent" | "person", write: () => Promise<number | undefined>) => {
    try {
      version = (await write()) ?? version
    } catch {
      failed.push(slot)
    }
  }
  let version = created.version
  const namePerson = () => attempt("person", async () => {
    if (version === undefined) throw new Error("no version to edit against")
    return (await api.updateWorkItem(created.id, newTodoEditRequest({ humanAssignee: person }, version))).workItem.version
  })
  if (!assignee && person === OPERATOR_ASSIGNEE) {
    await attempt("person", async () => (await api.assignWorkItem(created.id, OPERATOR_ASSIGNEE)).workItem.version)
  } else {
    if (person && person !== OPERATOR_ASSIGNEE) await namePerson()
    if (assignee) await attempt("agent", async () => (await api.assignWorkItem(created.id, assignee)).workItem.version)
    if (person === OPERATOR_ASSIGNEE) await namePerson()
  }
  if (failed.length) throw new AssignOnCreateError(failed.sort())
}
