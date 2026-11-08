import { api } from "@/lib/api"
import { newTodoEditRequest } from "./todo-edit-request"
import { OPERATOR_ASSIGNEE } from "./util"

/** Who a new Todo is created for: the agent who does the work and the person responsible, either or both. */
export interface CreateAssignees {
  assignee: string | null
  person: string | null
}

/**
 * Make the choices the create dialog collected, once the Todo exists. Yourself with no agent is the create-assigned-to-you
 * the dialog always offered: the assign route, which stores `@operator`. Anything else names the agent through the assign route
 * and the person through the pen, the same two lanes the Todo page uses, so neither slot disturbs the other.
 */
export async function assignOnCreate(created: { id: string; version?: number }, { assignee, person }: CreateAssignees): Promise<void> {
  if (!assignee && person === OPERATOR_ASSIGNEE) {
    await api.assignWorkItem(created.id, OPERATOR_ASSIGNEE)
    return
  }
  let version = created.version
  if (assignee) version = (await api.assignWorkItem(created.id, assignee)).workItem.version ?? version
  if (person && version !== undefined) await api.updateWorkItem(created.id, newTodoEditRequest({ humanAssignee: person }, version))
}
