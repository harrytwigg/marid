import "@/test/preload-menus"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { MoveToMenu } from "../board/move-menu"

function item(status: WorkItemStatusWire): WorkItemCompactWire {
  return {
    id: "PLA-7",
    version: 1,
    title: "Item PLA-7",
    status,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: "PLA-7",
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-07-23T08:00:00.000Z",
    rank: null,
  }
}

/** A touch tap: the pointer sequence a finger makes, then the click the browser follows with. */
function tap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch", button: 0, pointerId: 1 })
  fireEvent.pointerUp(element, { pointerType: "touch", button: 0, pointerId: 1 })
  fireEvent.click(element)
}

const open = async () => {
  tap(screen.getByRole("button", { name: "Move PLA-7 to…" }))
  return screen.findByRole("menu")
}
const rowsOf = () => screen.getAllByRole("menuitemradio").map((row) => row.textContent)

describe("the card's Move to… menu", () => {
  it("lists the columns left to right, the current one marked, and only the moves the card can make", async () => {
    render(<MoveToMenu item={item("in_review")} openChildren={0} onMove={vi.fn()} />)
    await open()

    // From In review: To do is not a legal manual move; In progress, Blocked, Done and Cancelled are.
    expect(rowsOf()).toEqual(["Blocked", "In progress", "In review", "Done", "Cancelled"])
    expect(screen.getByRole("menuitemradio", { name: "In review" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("menuitemradio", { name: "Done" }).getAttribute("aria-checked")).toBe("false")
  })

  it("moves the card on a tap of a column, and nothing for the column it is in", async () => {
    const onMove = vi.fn()
    render(<MoveToMenu item={item("executing")} openChildren={0} onMove={onMove} />)
    await open()

    tap(screen.getByRole("menuitemradio", { name: "In progress" }))
    expect(onMove).not.toHaveBeenCalled()

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await open()
    tap(screen.getByRole("menuitemradio", { name: "In review" }))
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "PLA-7" }), "in_review"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("shows a close that would also close open sub-tasks with its reason, and cannot be chosen", async () => {
    const onMove = vi.fn()
    render(<MoveToMenu item={item("executing")} openChildren={2} onMove={onMove} />)
    await open()

    const done = screen.getByRole("menuitemradio", { name: /Done/ })
    expect(done.getAttribute("aria-disabled")).toBe("true")
    expect(done.textContent).toContain("also closes 2 open sub-tasks")
    tap(done)
    expect(onMove).not.toHaveBeenCalled()
    // Cancelled is gated outright over open sub-tasks.
    expect(screen.getByRole("menuitemradio", { name: /Cancelled/ }).getAttribute("aria-disabled")).toBe("true")
  })

  it("keeps a tap on the menu from reaching the card around it", async () => {
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <MoveToMenu item={item("executing")} openChildren={0} onMove={vi.fn()} />
      </div>,
    )
    await open()
    tap(screen.getByRole("menuitemradio", { name: "In review" }))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
