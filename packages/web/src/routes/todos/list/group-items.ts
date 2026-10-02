import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"

export interface TodoListColumnInput {
  items: WorkItemCompactWire[]
  total: number
}

export type TodoListColumns = Record<WorkItemStatusWire, TodoListColumnInput>

export type TodoListGroupKey =
  | "recovering"
  | "manager"
  | "executing"
  | "in-review"
  | "backlog"
  | "blocked"
  | "closed"

export interface TodoListGroup {
  key: TodoListGroupKey
  label: string
  statuses: WorkItemStatusWire[]
  items: WorkItemCompactWire[]
  count: number
  collapsed?: boolean
}

const OPEN_GROUPS: Array<{
  key: Exclude<TodoListGroupKey, "recovering" | "manager" | "closed">
  label: string
  status: WorkItemStatusWire
  omitWhenEmpty?: boolean
}> = [
  { key: "executing", label: "In progress", status: "executing" },
  { key: "in-review", label: "In review", status: "in_review" },
  { key: "backlog", label: "Backlog", status: "backlog" },
  { key: "blocked", label: "Blocked", status: "blocked", omitWhenEmpty: true },
]

function attentionGroup(key: Extract<TodoListGroupKey, "recovering" | "manager">, label: string, items: WorkItemCompactWire[]): TodoListGroup {
  return { key, label, statuses: [], items, count: items.length }
}

function attentionGroups(hoisted: WorkItemCompactWire[]): TodoListGroup[] {
  const recovering = hoisted.filter((item) => item.attentionLane === "recovering")
  const manager = hoisted.filter((item) => item.attentionLane === "manager")
  const groups: TodoListGroup[] = []
  if (recovering.length > 0) groups.push(attentionGroup("recovering", "Recovering automatically", recovering))
  if (manager.length > 0) groups.push(attentionGroup("manager", "Manager attention", manager))
  return groups
}

export function groupTodoListItems(
  columns: TodoListColumns,
  needsAttention: WorkItemCompactWire[],
  /** A URL that names one status scopes the view to it, and the columns outside
   *  that scope are never queried. Those groups are omitted rather than drawn as
   *  a zero — "Backlog 0" would claim something nobody asked the gateway. */
  statusInScope: (status: WorkItemStatusWire) => boolean = () => true,
): TodoListGroup[] {
  // Only the lanes the operator is not the actor on are lifted out of their
  // status column. Everything else, including blocked work waiting on the
  // operator, stays under its own status.
  const hoisted = needsAttention.filter((item) => item.attentionLane === "recovering" || item.attentionLane === "manager")
  const attentionIds = new Set(hoisted.map(({ id }) => id))
  const hoistedByStatus = new Map<WorkItemStatusWire, number>()
  for (const item of hoisted) {
    hoistedByStatus.set(item.status, (hoistedByStatus.get(item.status) ?? 0) + 1)
  }

  const groups: TodoListGroup[] = attentionGroups(hoisted)

  for (const definition of OPEN_GROUPS) {
    const column = columns[definition.status]
    const items = column.items.filter(({ id }) => !attentionIds.has(id))
    const count = Math.max(items.length, column.total - (hoistedByStatus.get(definition.status) ?? 0))
    const omitWhenEmpty = definition.omitWhenEmpty || !statusInScope(definition.status)
    if (omitWhenEmpty && count === 0) continue
    groups.push({
      key: definition.key,
      label: definition.label,
      statuses: [definition.status],
      items,
      count,
    })
  }

  const closed = closedGroup(columns, attentionIds, hoistedByStatus, statusInScope)
  if (closed) groups.push(closed)

  return groups
}

/** The collapsed Closed row, or null when this view never asked for closed work. */
function closedGroup(
  columns: TodoListColumns,
  attentionIds: ReadonlySet<string>,
  hoistedByStatus: ReadonlyMap<WorkItemStatusWire, number>,
  statusInScope: (status: WorkItemStatusWire) => boolean,
): TodoListGroup | null {
  const statuses: WorkItemStatusWire[] = ["done", "cancelled"]
  const items = statuses.flatMap((status) => columns[status].items.filter(({ id }) => !attentionIds.has(id)))
  if (items.length === 0 && !statuses.some(statusInScope)) return null
  const count = statuses.reduce(
    (total, status) => total + columns[status].total - (hoistedByStatus.get(status) ?? 0),
    0,
  )
  return { key: "closed", label: "Closed", statuses, items, count: Math.max(items.length, count), collapsed: true }
}
