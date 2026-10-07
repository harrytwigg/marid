import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"

export interface TodoListColumnInput {
  items: WorkItemCompactWire[]
  total: number
}

export type TodoListColumns = Record<WorkItemStatusWire, TodoListColumnInput>

export type TodoListGroupKey =
  | "recovering"
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
  key: Exclude<TodoListGroupKey, "recovering" | "closed">
  label: string
  status: WorkItemStatusWire
  omitWhenEmpty?: boolean
}> = [
  { key: "executing", label: "In progress", status: "executing" },
  { key: "in-review", label: "In review", status: "in_review" },
  { key: "backlog", label: "To do", status: "backlog" },
  { key: "blocked", label: "Blocked", status: "blocked", omitWhenEmpty: true },
]

function recoveringGroups(items: WorkItemCompactWire[]): TodoListGroup[] {
  if (items.length === 0) return []
  return [{ key: "recovering", label: "Recovering automatically", statuses: [], items, count: items.length }]
}

export function groupTodoListItems(
  columns: TodoListColumns,
  needsAttention: WorkItemCompactWire[],
  /** A URL that names one status scopes the view to it, and the columns outside
   *  that scope are never queried. Those groups are omitted rather than drawn as
   *  a zero — "To do 0" would claim something nobody asked the gateway. */
  statusInScope: (status: WorkItemStatusWire) => boolean = () => true,
): TodoListGroup[] {
  // Only recovering work, which nobody needs to act on, is lifted out of its
  // status column. Everything else, including manager-lane work and blocked
  // work waiting on the operator, stays under its own status as on the board.
  const hoisted = needsAttention.filter((item) => item.attentionLane === "recovering")
  const attentionIds = new Set(hoisted.map(({ id }) => id))
  const hoistedByStatus = new Map<WorkItemStatusWire, number>()
  for (const item of hoisted) {
    hoistedByStatus.set(item.status, (hoistedByStatus.get(item.status) ?? 0) + 1)
  }

  const groups: TodoListGroup[] = recoveringGroups(hoisted)

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
