import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { WorkItemStatusWire, WorkItemTreeNodeWire } from "@/lib/api"
import { workItemNode } from "./fixtures/task-wire"
import { SubTasksSection } from "../task-page/subtasks"
import { PENDING_SUBTASK_PREFIX } from "../task-page/use-subtask-mutations"

/** The collapsible sub-tasks group and its inline add field, driven
 *  bare with stub callbacks. The optimistic insert itself lives a level up, in
 *  subtask-optimistic.test.tsx, because it is the query cache that carries it. */

const child = (id: string, status: WorkItemStatusWire = "executing") => workItemNode(id, { status })

function renderSection(children: WorkItemTreeNodeWire[], parentDepth = 0) {
  const onAddSubTask = vi.fn()
  render(
    <SubTasksSection
      node={{ ...child("TSK-12"), depth: 0, parentId: null, children }}
      parentDepth={parentDepth}
      employees={[]}
      byName={new Map()}
      mobile={false}
      onOpenChild={vi.fn()}
      onChildStatus={vi.fn()}
      onChildAssign={vi.fn()}
      onAddSubTask={onAddSubTask}
    />,
  )
  return { onAddSubTask }
}

describe("sub-tasks group", () => {
  it("collapses to its header and restores, tracking aria-expanded", () => {
    renderSection([child("TSK-13"), child("TSK-14")])
    const toggle = screen.getByTestId("subtasks-toggle")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")

    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("subtask-row-TSK-13")).toBeNull()
    expect(screen.queryByTestId("subtasks-progress")).toBeNull()
    expect(screen.getByTestId("subtasks-count").textContent).toBe("2")
    expect(screen.getByTestId("subtask-add")).toBeTruthy()

    fireEvent.click(toggle)
    expect(screen.getByTestId("subtask-row-TSK-13")).toBeTruthy()
    expect(screen.getByTestId("subtasks-progress")).toBeTruthy()
  })

  it("keeps the header and its + for a Todo with no sub-tasks, with no placeholder and no progress", () => {
    renderSection([])
    expect(screen.getByTestId("task-subtasks")).toBeTruthy()
    expect(screen.getByTestId("subtask-add")).toBeTruthy()
    expect(screen.getByTestId("subtasks-count").textContent).toBe("0")
    expect(screen.queryByTestId("subtasks-progress")).toBeNull()
    expect(screen.queryByTestId("subtasks-done")).toBeNull()
  })

  it("counts the whole subtree and holds 'N of M done' back until one is closed", () => {
    renderSection([child("TSK-13"), { ...child("TSK-14"), children: [child("TSK-15")] }])
    expect(screen.getByTestId("subtasks-count").textContent).toBe("3")
    expect(screen.queryByTestId("subtasks-done")).toBeNull()
  })

  it("reads 'N of M done' once a descendant is closed", () => {
    renderSection([child("TSK-13", "done"), child("TSK-14")])
    expect(screen.getByTestId("subtasks-done").textContent).toBe("1 of 2 done")
  })

  it("opens a focused field as the last row of the list, animated and not a dialog", () => {
    renderSection([child("TSK-13")])
    expect(screen.queryByTestId("subtask-add-input")).toBeNull()

    fireEvent.click(screen.getByTestId("subtask-add"))
    const field = screen.getByTestId("subtask-add-input")
    expect(document.activeElement).toBe(field)
    expect(field.closest("[role=dialog]")).toBeNull()

    const row = screen.getByTestId("subtask-add-row")
    expect(row.className).toContain("motion-safe:animate-capture-step-in")
    expect(screen.getByTestId("subtask-list").lastElementChild).toBe(row)
  })

  it("expands the group when + is pressed while it is collapsed", () => {
    renderSection([child("TSK-13")])
    fireEvent.click(screen.getByTestId("subtasks-toggle"))
    fireEvent.click(screen.getByTestId("subtask-add"))
    expect(screen.getByTestId("subtasks-toggle").getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("subtask-add-input")).toBeTruthy()
  })

  it("creates on Enter and stays open and focused for the next one", () => {
    const { onAddSubTask } = renderSection([child("TSK-13")])
    fireEvent.click(screen.getByTestId("subtask-add"))
    const field = screen.getByTestId("subtask-add-input") as HTMLInputElement
    fireEvent.change(field, { target: { value: "Ship it" } })
    fireEvent.keyDown(field, { key: "Enter" })

    expect(onAddSubTask).toHaveBeenCalledWith("Ship it")
    expect(field.value).toBe("")
    expect(screen.getByTestId("subtask-add-input")).toBe(field)
    expect(document.activeElement).toBe(field)
  })

  it("closes on Escape without creating, and closes on blur when empty", () => {
    const { onAddSubTask } = renderSection([child("TSK-13")])
    fireEvent.click(screen.getByTestId("subtask-add"))
    const field = screen.getByTestId("subtask-add-input")
    fireEvent.change(field, { target: { value: "Nope" } })
    fireEvent.keyDown(field, { key: "Escape" })
    expect(onAddSubTask).not.toHaveBeenCalled()
    expect(screen.queryByTestId("subtask-add-input")).toBeNull()

    fireEvent.click(screen.getByTestId("subtask-add"))
    fireEvent.blur(screen.getByTestId("subtask-add-input"))
    expect(onAddSubTask).not.toHaveBeenCalled()
    expect(screen.queryByTestId("subtask-add-input")).toBeNull()
  })

  it("offers no + and no field at the depth cap", () => {
    renderSection([child("TSK-13")], 3)
    expect(screen.queryByTestId("subtask-add")).toBeNull()
    expect(screen.queryByTestId("subtask-add-input")).toBeNull()
    expect(screen.getByTestId("subtask-depth-cap")).toBeTruthy()
  })

  it("renders a child the gateway has not minted yet as a quiet row with no actions", () => {
    renderSection([child("TSK-13"), { ...child(`${PENDING_SUBTASK_PREFIX}1`), title: "In flight" }])
    const pending = screen.getByTestId("subtask-pending-row")
    expect(pending.textContent).toContain("In flight")
    expect(screen.queryByTestId(`subtask-open-${PENDING_SUBTASK_PREFIX}1`)).toBeNull()
  })
})
