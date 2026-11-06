import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { WorkItemTreeNodeWire } from "@/lib/api"
import { OPERATOR_CAPABILITIES, isMemberOnlyTree, memberCapabilities, type TodoCapabilities } from "@/lib/todo-capabilities"
import { useBoardAbilities, useMember } from "./use-principal"

const TodoCapabilitiesContext = createContext<TodoCapabilities>(OPERATOR_CAPABILITIES)

/** What the person may do on the Todo page they are looking at. Anything rendered outside a provider is the operator's. */
export function useTodoCapabilities(): TodoCapabilities {
  return useContext(TodoCapabilitiesContext)
}

/** The capabilities for one Todo: the operator's, or a member's role on the Todo's board applied to its tree. */
export function useTodoCapabilitiesFor(department: string | null | undefined, root: WorkItemTreeNodeWire | undefined): TodoCapabilities {
  const member = useMember()
  const abilities = useBoardAbilities(department)
  const memberOnly = isMemberOnlyTree(root)
  return useMemo(
    () => (member ? memberCapabilities(abilities?.role, memberOnly) : OPERATOR_CAPABILITIES),
    [member, abilities?.role, memberOnly],
  )
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
