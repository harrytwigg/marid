import { useCallback, useRef } from "react"
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import type { WorkItemCompactWire } from "@/lib/api"
import type { TodoListGroup } from "./group-items"

/**
 * Windowing for the grouped Todo list.
 *
 * The list is sections of rows, and a section is not a unit the reader scrolls
 * past whole — a single To do group can be the entire scroll. So the virtual row is
 * one visible line: a group's header, one Todo, its empty caption, or its
 * "Show more". Flattening that way is what lets a 500-Todo To do group cost the same
 * as a 20-Todo one; virtualising per section would still mount every row inside
 * the section the reader is in.
 *
 * The gap above the virtual block — the container's top padding — is declared as
 * `scrollMargin`. Not for the visible range, which the overscan band covers many
 * times over, but for the test the virtualizer applies when a row re-measures:
 * it asks whether the row sits above the reader by comparing the row's own
 * `start`, which counts from the top of the block, against the scroller's raw
 * `scrollTop`. Undeclared, those are two coordinate systems off by exactly that
 * gap, and every row in the top of the viewport reads as one above the reader
 * and takes a scroll correction the reader watches happen. Rows are positioned
 * at `start - scrollMargin`, so declaring it moves nothing.
 */

/** Below this many Todos the list renders every row of it, as it always has. */
export const VIRTUALIZE_THRESHOLD = 50

/** Rows kept mounted beyond the visible window, each side. */
const OVERSCAN = 8

/** Resting heights, in px. Wrong is fine — every mounted row re-measures. */
const HEADER_SIZE = 52
const ITEM_SIZE = 44
const EMPTY_SIZE = 36
const SHOW_MORE_SIZE = 44

/** A group plus the paging state gathered from the columns it spans. */
export interface TodoListSection {
  group: TodoListGroup
  open: boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

export type TodoListVirtualRow =
  | { kind: "header"; key: string; section: TodoListSection; first: boolean }
  | { kind: "item"; key: string; section: TodoListSection; item: WorkItemCompactWire }
  | { kind: "empty"; key: string; section: TodoListSection }
  | { kind: "show-more"; key: string; section: TodoListSection }

/** The visible lines of the whole list, in the order they are drawn. */
export function flattenTodoListSections(sections: TodoListSection[]): TodoListVirtualRow[] {
  const rows: TodoListVirtualRow[] = []
  sections.forEach((section, index) => {
    const groupKey = section.group.key
    rows.push({ kind: "header", key: `header-${groupKey}`, section, first: index === 0 })
    if (!section.open) return
    for (const item of section.group.items) {
      // Scoped by group so a Todo hoisted into an attention group while still listed by
      // its own status could never collide with itself.
      rows.push({ kind: "item", key: `item-${groupKey}-${item.id}`, section, item })
    }
    if (section.group.items.length === 0) rows.push({ kind: "empty", key: `empty-${groupKey}`, section })
    if (section.hasMore) rows.push({ kind: "show-more", key: `more-${groupKey}`, section })
  })
  return rows
}

function estimateTodoListRowSize(row: TodoListVirtualRow): number {
  switch (row.kind) {
    case "header": return HEADER_SIZE
    case "empty": return EMPTY_SIZE
    case "show-more": return SHOW_MORE_SIZE
    default: return ITEM_SIZE
  }
}

export type TodoListVirtualizer = Virtualizer<HTMLDivElement, Element>

export function useTodoListVirtualizer(
  rows: TodoListVirtualRow[],
  keys: string[],
  getScrollElement: () => HTMLDivElement | null,
  /** How far the virtual block starts below the scrollport's top. */
  scrollMargin: number,
): TodoListVirtualizer {
  // Read through a ref: the key extractor's identity invalidates the whole
  // measurement pass, and a fresh closure per render would rebuild it every time
  // a filter, a poll or a paging click re-rendered the page.
  const keysRef = useRef(keys)
  keysRef.current = keys
  return useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: (index) => estimateTodoListRowSize(rows[index]),
    getItemKey: useCallback((index: number) => keysRef.current[index], []),
    overscan: OVERSCAN,
    scrollMargin,
  })
}
