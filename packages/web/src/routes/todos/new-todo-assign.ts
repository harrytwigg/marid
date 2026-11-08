import { api } from "@/lib/api"
import { newTodoEditRequest } from "./todo-edit-request"
import { OPERATOR_ASSIGNEE } from "./util"

/** Who a new Todo is created for: the agent who does the work and the person responsible, either or both. */
export interface CreateAssignees {
  assignee: string | null
  person: string | null
}

/** Which slot a create could not fill once the Todo existed, so the dialog can say so. */
export class AssignOnCreateError extends Error {
  constructor(readonly slot: "agent" | "person", cause: unknown) {
    super(`could not set the ${slot}`, { cause })
  }
}

async function fill<T>(slot: "agent" | "person", write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    throw new AssignOnCreateError(slot, error)
  }
}

/**
 * Make the choices the create dialog collected, once the Todo exists. Yourself with no agent is the create-assigned-to-you
 * the dialog always offered: the assign route, which stores `@operator`. Anything else names the agent through the assign route
 * and the person through the pen, the same two lanes the Todo page uses, so neither slot disturbs the other. A board member
 * is named before the agent: an agent from another board moves the Todo there, and the member is named on the board the
 * draft chose (the person row then stays through the move, as it does on the Todo page). The operator as the person goes
 * after the agent, which keeps them beside it instead of making the Todo wait on them first.
 */
export async function assignOnCreate(created: { id: string; version?: number }, { assignee, person }: CreateAssignees): Promise<void> {
  if (!assignee && person === OPERATOR_ASSIGNEE) {
    await fill("person", () => api.assignWorkItem(created.id, OPERATOR_ASSIGNEE))
    return
  }
  let version = created.version
  const namePerson = async () => {
    if (!person || version === undefined) return
    const next = await fill("person", () => api.updateWorkItem(created.id, newTodoEditRequest({ humanAssignee: person }, version!)))
    version = next.workItem.version ?? version
  }
  if (person !== OPERATOR_ASSIGNEE) await namePerson()
  if (assignee) version = (await fill("agent", () => api.assignWorkItem(created.id, assignee))).workItem.version ?? version
  if (person === OPERATOR_ASSIGNEE) await namePerson()
}
