import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { WorkItemTreeNodeWire } from "@/lib/api"
import { OPERATOR_CAPABILITIES, isMemberOnlyTree, memberCapabilities, movedCapabilities, type TodoCapabilities } from "@/lib/todo-capabilities"
import { useBoardAbilities, useMember } from "./use-principal"

const TodoCapabilitiesContext = createContext<TodoCapabilities>(OPERATOR_CAPABILITIES)

/** What the person may do on the Todo page they are looking at. Anything rendered outside a provider is the operator's. */
export function useTodoCapabilities(): TodoCapabilities {
  return useContext(TodoCapabilitiesContext)
}

/**
 * The capabilities for one Todo: the operator's, or a member's role on the Todo's board applied to its tree. A Todo the
 * member reads only as its creator, after it left the board they filed it on (`moved`), is read-only, and commentable where
 * the gateway says their role on that board allows comments.
 */
export function useTodoCapabilitiesFor(
  department: string | null | undefined,
  root: WorkItemTreeNodeWire | undefined,
  moved: { canComment: boolean } | null = null,
): TodoCapabilities {
  const member = useMember()
  const abilities = useBoardAbilities(department)
  const memberOnly = isMemberOnlyTree(root)
  const movedComment = moved?.canComment
  return useMemo(() => {
    if (!member) return OPERATOR_CAPABILITIES
    return movedComment !== undefined ? movedCapabilities(movedComment) : memberCapabilities(abilities?.role, memberOnly)
  }, [member, abilities?.role, memberOnly, movedComment])
}

export function TodoCapabilitiesProvider({ value, children }: { value: TodoCapabilities; children: ReactNode }) {
  return <TodoCapabilitiesContext.Provider value={value}>{children}</TodoCapabilitiesContext.Provider>
}

type RowKey = "status" | "priority" | "assignee" | "person" | "labels" | "department" | "start" | "due"

/** The property rows a person may open: all of them for the operator; for a member priority where they may edit, and the person row where they collaborate on the board. */
export function restrictRows<R>(rowFor: (row: RowKey) => R | undefined, caps: TodoCapabilities): (row: RowKey) => R | undefined {
  if (caps.operatorControls) return rowFor
  return (row) => ((row === "priority" && caps.edit) || (row === "person" && caps.person) ? rowFor(row) : undefined)
}
