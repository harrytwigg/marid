import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, PointMenu } from "../context-menu"

function Example({ onRename = vi.fn() }: { onRename?: () => void }) {
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <a href="#row" data-testid="row">A session</a>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label="Session actions">
          <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
          <ContextMenuItem>Archive</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <button type="button">Elsewhere</button>
    </>
  )
}

const row = () => screen.getByTestId("row")
const anchor = () => document.querySelector<HTMLElement>("[data-context-menu-anchor]")

afterEach(() => vi.useRealTimers())

describe("ContextMenu", () => {
  it("opens at the pointer on a right-click, in place of the browser's own menu", async () => {
    render(<Example />)
    expect(screen.queryByRole("menu")).toBeNull()

    // fireEvent returns false when a handler called preventDefault.
    const notPrevented = fireEvent.contextMenu(row(), { clientX: 120, clientY: 80 })

    expect(notPrevented).toBe(false)
    await screen.findByRole("menu", { name: "Session actions" })
    expect(anchor()?.style.left).toBe("120px")
    expect(anchor()?.style.top).toBe("80px")
    expect(row().hasAttribute("data-menu-open")).toBe(true)
  })

  it.each([["Shift+F10", "{Shift>}{F10}{/Shift}"], ["the Menu key", "{ContextMenu}"]])("opens from %s with focus on the first item", async (_name, keys) => {
    render(<Example />)
    row().focus()

    await userEvent.keyboard(keys)

    await screen.findByRole("menu")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })))
  })

  it("Escape closes it and focus goes back to the row that had it", async () => {
    render(<Example />)
    row().focus()
    await userEvent.keyboard("{Shift>}{F10}{/Shift}")
    await screen.findByRole("menu")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(row()))
    expect(row().hasAttribute("data-menu-open")).toBe(false)
  })

  it("choosing an item runs it and closes the menu", async () => {
    const onRename = vi.fn()
    render(<Example onRename={onRename} />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })

    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))

    expect(onRename).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("moves with the arrow keys once it is open", async () => {
    render(<Example />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    await screen.findByRole("menu")

    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }))
    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Archive" }))
  })

  it("closes on a press outside it, and the press goes on to what it landed on", async () => {
    const onElsewhere = vi.fn()
    render(
      <>
        <Example />
        <button type="button" onClick={onElsewhere}>Elsewhere too</button>
      </>,
    )
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    await screen.findByRole("menu")

    await userEvent.click(screen.getByRole("button", { name: "Elsewhere too" }))

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(onElsewhere).toHaveBeenCalledTimes(1)
  })

  it("closes on a press on something that cannot take focus", async () => {
    render(
      <>
        <Example />
        <p data-testid="text">Some text</p>
      </>,
    )
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    await screen.findByRole("menu")

    fireEvent.pointerDown(screen.getByTestId("text"), { button: 0 })

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("a second right-click moves the menu to the new point", async () => {
    render(<Example />)
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 10 })
    await screen.findByRole("menu")

    fireEvent.contextMenu(row(), { clientX: 200, clientY: 150 })

    await waitFor(() => expect(anchor()?.style.left).toBe("200px"))
    expect(screen.getAllByRole("menu")).toHaveLength(1)
  })

  it("opens on a touch held for 700 ms, and not on one that moves or lifts first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Example />)

    fireEvent.pointerDown(row(), { pointerType: "touch", clientX: 30, clientY: 30 })
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    fireEvent.pointerUp(row(), { pointerType: "touch" })
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(screen.queryByRole("menu")).toBeNull()

    fireEvent.pointerDown(row(), { pointerType: "touch", clientX: 30, clientY: 30 })
    fireEvent.pointerMove(row(), { pointerType: "touch", clientX: 60, clientY: 30 })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(screen.queryByRole("menu")).toBeNull()

    fireEvent.pointerDown(row(), { pointerType: "touch", clientX: 30, clientY: 30 })
    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    await screen.findByRole("menu")
    expect(anchor()?.style.left).toBe("30px")
  })

  it("does not open on a held mouse button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<Example />)

    fireEvent.pointerDown(row(), { pointerType: "mouse", clientX: 30, clientY: 30 })
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })

    expect(screen.queryByRole("menu")).toBeNull()
  })
})

describe("PointMenu", () => {
  it("is open at its point until it asks to close", async () => {
    const onOpenChange = vi.fn()
    render(
      <PointMenu point={{ x: 40, y: 60 }} onOpenChange={onOpenChange}>
        <ContextMenuContent aria-label="At a point">
          <ContextMenuItem>Move</ContextMenuItem>
        </ContextMenuContent>
      </PointMenu>,
    )

    await screen.findByRole("menu", { name: "At a point" })
    expect(anchor()?.style.left).toBe("40px")

    await userEvent.keyboard("{Escape}")

    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it("renders nothing without a point", () => {
    render(
      <PointMenu point={null}>
        <ContextMenuContent aria-label="At a point">
          <ContextMenuItem>Move</ContextMenuItem>
        </ContextMenuContent>
      </PointMenu>,
    )

    expect(screen.queryByRole("menu")).toBeNull()
    expect(anchor()).toBeNull()
  })
})
