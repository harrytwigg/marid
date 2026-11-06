import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { WorkItemTreeNodeWire } from "@/lib/api"
import { OPERATOR_CAPABILITIES, isMemberOnlyTree, memberCapabilities, movedCapabilities, type TodoCapabilities } from "@/lib/todo-capabilities"
import { useBoardAbilities, useMember, useMemberGrants } from "./use-principal"

const TodoCapabilitiesContext = createContext<TodoCapabilities>(OPERATOR_CAPABILITIES)

/** What the person may do on the Todo page they are looking at. Anything rendered outside a provider is the operator's. */
export function useTodoCapabilities(): TodoCapabilities {
  return useContext(TodoCapabilitiesContext)
}

/**
 * The capabilities for one Todo: the operator's, or a member's role on the Todo's board applied to its tree. A Todo the
 * member reads only as its creator, after it left their boards (`moved`), is read-only and commentable where any role of
 * theirs allows comments, which is the rule the gateway applies.
 */
export function useTodoCapabilitiesFor(
  department: string | null | undefined,
  root: WorkItemTreeNodeWire | undefined,
  moved = false,
): TodoCapabilities {
  const member = useMember()
  const abilities = useBoardAbilities(department)
  const grants = useMemberGrants()
  const memberOnly = isMemberOnlyTree(root)
  const canComment = !!grants?.some((grant) => grant.role === "collaborator" || grant.role === "owner")
  return useMemo(() => {
    if (!member) return OPERATOR_CAPABILITIES
    return moved ? movedCapabilities(canComment) : memberCapabilities(abilities?.role, memberOnly)
  }, [member, abilities?.role, memberOnly, moved, canComment])
}

export function TodoCapabilitiesProvider({ value, children }: { value: TodoCapabilities; children: ReactNode }) {
  return <TodoCapabilitiesContext.Provider value={value}>{children}</TodoCapabilitiesContext.Provider>
}

type RowKey = "status" | "priority" | "assignee" | "labels" | "department" | "start" | "due"

/** The property rows a person may open: all of them for the operator; for a member only priority, and only where they may edit. */
export function restrictRows<R>(rowFor: (row: RowKey) => R | undefined, caps: TodoCapabilities): (row: RowKey) => R | undefined {
  if (caps.operatorControls) return rowFor
  return (row) => (row === "priority" && caps.edit ? rowFor(row) : undefined)
}
