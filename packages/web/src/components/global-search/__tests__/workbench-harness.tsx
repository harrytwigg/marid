import { fireEvent, screen } from "@testing-library/react"
import type { Employee, WorkItemDetailWire, WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import { detailOf } from "./todo-fixtures"

/* How the workbench is mounted and driven. What it is supposed to do lives next
 * door in workbench.test.tsx; this is only the harness and its fixtures. */

export const TODO_ID = "AAA-1"
/** A second Todo row, so a selection can move Todo-to-Todo without the
 *  workbench unmounting on the way. */
export const OTHER_TODO_ID = "AAA-2"

export const EMPLOYEES: Employee[] = ["a-lead", "b-lead"].map((name, index) => ({
  name,
  displayName: index === 0 ? "A Lead" : "B Lead",
  department: "platform",
  rank: "senior",
  engine: "codex",
  model: "a-model",
  persona: "",
}))

export function todoDetail(
  over: Partial<WorkItemDetailWire["workItem"]> = {},
  id: string = TODO_ID,
): WorkItemDetailWire {
  return detailOf(id, over)
}

/** The subtree behind the close gate, as the gateway hands it back. */
export function treeOf(children: WorkItemStatusWire[]) {
  const root: WorkItemTreeNodeWire = {
    ...todoDetail().workItem,
    children: children.map((status, index) => ({
      ...todoDetail({ status }).workItem,
      id: `${TODO_ID}${index}`,
      children: [],
    })),
  }
  return { tree: { root, totals: {}, spendUsd: 0 } }
}

/** Move the selection with the keyboard, the way the overlay is meant to be driven. */
export function selectRow(index: number) {
  const field = document.querySelector<HTMLInputElement>("input[aria-label^='Search']")!
  for (let step = 0; step < index; step += 1) fireEvent.keyDown(field, { key: "ArrowDown" })
}

/** Open a property's picker and wait for its rows — the status picker holds a
 *  note until the close gate's read of the sub-tasks lands. */
export async function openPicker(property: "status" | "assignee") {
  fireEvent.click(screen.getByTestId(`workbench-row-${property}`))
  await screen.findByTestId(
    property === "status" ? "status-option-done" : "assignee-option-unassign",
  )
}

/** A promise the test settles by hand, so an in-flight write can be looked at. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // A rejection nobody has awaited yet is not an unhandled one.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export function rowText(): string {
  return screen.getByTestId(`search-row-todo:${TODO_ID}`).textContent ?? ""
}

export function previewText(): string {
  return screen.getByTestId("search-preview").textContent ?? ""
}
