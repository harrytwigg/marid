import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Employee, WorkItemCompactWire, WorkItemTreeWire } from "@/lib/api"
import { useVirtualBlockOffset } from "@/components/chat/virtual-block-offset"
import { TodoListGroupEmpty, TodoListGroupHeader, TodoListShowMore } from "./list-group"
import { TodoListRow } from "./list-row"
import { useTodoListVirtualizer, type TodoListVirtualRow } from "./list-virtualizer"

/** The gap between sections, which the flex container owns on the plain path. */
const SECTION_GAP = "pt-[18px]"

export interface TodoListRowHandlers {
  byName: Map<string, Employee>
  trees: Map<string, WorkItemTreeWire> | undefined
  now: number
  onOpen: (id: string, item: WorkItemCompactWire) => void
  onQuickAdd: () => void
  onToggleClosed: () => void
  onKeep?: (vars: { id: string; kept: boolean }) => void
}

/** A section header as one windowed row: the `<section>` carries the group's
 *  test id, and the padding the flex container gives it on the plain path. */
function WindowedGroupHeader({
  row,
  onQuickAdd,
  onToggleClosed,
}: {
  row: Extract<TodoListVirtualRow, { kind: "header" }>
  onQuickAdd: TodoListRowHandlers["onQuickAdd"]
  onToggleClosed: () => void
}) {
  const { group, open } = row.section
  return (
    <section
      data-testid={`todo-list-group-${group.key}`}
      className={`${row.first ? "" : SECTION_GAP} ${open ? "pb-0.5" : ""}`}
    >
      <TodoListGroupHeader
        group={group}
        open={open}
        onToggle={group.key === "closed" ? onToggleClosed : undefined}
        onQuickAdd={() => onQuickAdd()}
      />
    </section>
  )
}

function WindowedRow({ row, handlers }: { row: TodoListVirtualRow; handlers: TodoListRowHandlers }) {
  switch (row.kind) {
    case "header":
      return <WindowedGroupHeader row={row} onQuickAdd={handlers.onQuickAdd} onToggleClosed={handlers.onToggleClosed} />
    case "item":
      return (
        <TodoListRow
          item={row.item}
          priority={handlers.trees?.get(row.item.id)?.root.priority ?? 0}
          byName={handlers.byName}
          now={handlers.now}
          onOpen={handlers.onOpen}
          onKeep={handlers.onKeep}
        />
      )
    case "empty":
      return <TodoListGroupEmpty />
    case "show-more":
      return (
        <TodoListShowMore
          group={row.section.group}
          loadingMore={row.section.loadingMore}
          onLoadMore={row.section.onLoadMore}
        />
      )
  }
}

/**
 * The list, windowed. Only the rows around the scroll position are mounted, so
 * a To do group of five hundred costs what a To do group of twenty does.
 */
export function WindowedTodoList({
  rows,
  scrollRef,
  handlers,
  className,
}: {
  rows: TodoListVirtualRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  handlers: TodoListRowHandlers
  className: string
}) {
  const keys = useMemo(() => rows.map((row) => row.key), [rows])
  // The scrollport is an ancestor of this list, so React attaches its ref only
  // after this subtree's layout effects have run — the virtualizer's first look
  // finds nothing and, with no other reason to render, would stay empty. Reading
  // the element into state is what gives it a second look.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => setScrollEl(scrollRef.current), [scrollRef])
  const getScrollElement = useCallback(() => scrollEl, [scrollEl])
  // The block's offset goes back in as `scrollMargin`, and comes back off the
  // row transforms below — see the header of list-virtualizer.ts.
  const blockRef = useRef<HTMLDivElement>(null)
  const scrollMargin = useVirtualBlockOffset(blockRef, getScrollElement)
  const virtualizer = useTodoListVirtualizer(rows, keys, getScrollElement, scrollMargin)

  return (
    <div className={className}>
      <div ref={blockRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          // `data-index` is what the virtualizer measures by, so a row's own
          // test id stays exactly where it is on the plain path.
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
          >
            <WindowedRow row={rows[virtualRow.index]} handlers={handlers} />
          </div>
        ))}
      </div>
    </div>
  )
}
