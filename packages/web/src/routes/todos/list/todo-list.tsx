import { useCallback, useEffect, useMemo, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardColumnData } from "../board/use-board"
import { groupTodoListItems } from "./group-items"
import { TodoListGroup } from "./list-group"
import { flattenTodoListSections, VIRTUALIZE_THRESHOLD, type TodoListSection } from "./list-virtualizer"
import { WindowedTodoList, type TodoListRowHandlers } from "./list-window"

/** A group's paging state, gathered from the columns it spans. */
function paging(statuses: readonly WorkItemStatusWire[], columns: Record<WorkItemStatusWire, BoardColumnData>) {
  return {
    hasMore: statuses.some((status) => columns[status].hasMore),
    loadingMore: statuses.some((status) => columns[status].loadingMore),
    onLoadMore: () => {
      for (const status of statuses) {
        if (columns[status].hasMore) columns[status].loadMore()
      }
    },
  }
}

/** The list's own padding, so both paths sit in the same place on the page. */
const PADDING = "px-3 pt-5 md:px-10"

export interface TodoListProps {
  columns: Record<WorkItemStatusWire, BoardColumnData>
  needsAttention: WorkItemCompactWire[]
  byName: Map<string, Employee>
  trees: Map<string, WorkItemTreeWire> | undefined
  now: number
  onOpen: (id: string, item: WorkItemCompactWire) => void
  onQuickAdd: () => void
  onKeep?: (vars: { id: string; kept: boolean }) => void
  /** The scrollport this list lives in — a long list windows against it. */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Which statuses this view was asked for — see `groupTodoListItems`. */
  statusInScope?: (status: WorkItemStatusWire) => boolean
  /** A URL that named a closed status arrives with the group already open —
   *  Closed is folded because it is usually noise, and here it is the answer. */
  closedInitiallyOpen?: boolean
}

export function TodoList({
  columns,
  needsAttention,
  byName,
  trees,
  now,
  onOpen,
  onQuickAdd,
  onKeep,
  scrollRef,
  statusInScope,
  closedInitiallyOpen = false,
}: TodoListProps) {
  const groups = useMemo(() => groupTodoListItems(columns, needsAttention, statusInScope), [columns, needsAttention, statusInScope])
  const [closedOpen, setClosedOpen] = useState(closedInitiallyOpen)
  useEffect(() => setClosedOpen(closedInitiallyOpen), [closedInitiallyOpen])
  const toggleClosed = useCallback(() => setClosedOpen((value) => !value), [])

  const sections: TodoListSection[] = useMemo(
    () => groups.map((group) => ({
      group,
      open: group.key !== "closed" || closedOpen,
      ...paging(group.statuses, columns),
    })),
    [groups, columns, closedOpen],
  )
  const rows = useMemo(() => flattenTodoListSections(sections), [sections])
  // Headers, captions and "Show more" number a handful whatever the data, so
  // counting them in would window a list of forty Todos — short enough that
  // mounting it whole is the cheaper of the two.
  const todoCount = rows.reduce((count, row) => count + (row.kind === "item" ? 1 : 0), 0)

  const handlers: TodoListRowHandlers = { byName, trees, now, onOpen, onQuickAdd, onKeep, onToggleClosed: toggleClosed }
  return todoCount >= VIRTUALIZE_THRESHOLD
    ? <WindowedTodoList rows={rows} scrollRef={scrollRef} className={PADDING} handlers={handlers} />
    : <PlainTodoList sections={sections} handlers={handlers} />
}

/** Every row of every group, as the list has always drawn them. */
function PlainTodoList({ sections, handlers }: { sections: TodoListSection[]; handlers: TodoListRowHandlers }) {
  return (
    <div className={`flex flex-col gap-[18px] ${PADDING}`}>
      {sections.map((section) => (
        <TodoListGroup
          key={section.group.key}
          group={section.group}
          byName={handlers.byName}
          trees={handlers.trees}
          now={handlers.now}
          open={section.open}
          onToggle={section.group.key === "closed" ? handlers.onToggleClosed : undefined}
          onQuickAdd={() => handlers.onQuickAdd()}
          onOpen={handlers.onOpen}
          onKeep={handlers.onKeep}
          hasMore={section.hasMore}
          loadingMore={section.loadingMore}
          onLoadMore={section.onLoadMore}
        />
      ))}
    </div>
  )
}
