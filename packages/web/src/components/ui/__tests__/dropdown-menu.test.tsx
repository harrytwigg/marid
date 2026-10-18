import "@/test/preload-menus"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu"

function Example({ onOpenChange, onRename = vi.fn(), onArchive = vi.fn() }: { onOpenChange?: (open: boolean) => void; onRename?: () => void; onArchive?: () => void }) {
  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Session</DropdownMenuLabel>
          <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>Archive</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>Delete</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="#docs">Documentation</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button">Elsewhere</button>
    </>
  )
}

const trigger = () => screen.getByRole("button", { name: "Actions" })
const item = (name: string) => screen.getByRole("menuitem", { name })
const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

describe("DropdownMenu", () => {
  it("is a menu the trigger announces, named by the trigger, closed until it is asked for", async () => {
    render(<Example />)

    expect(screen.queryByRole("menu")).toBeNull()
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu")
    expect(trigger().getAttribute("aria-expanded")).toBe("false")
    expect(trigger().hasAttribute("data-menu-open")).toBe(false)

    await userEvent.click(trigger())

    const menu = await screen.findByRole("menu", { name: "Actions" })
    expect(trigger().getAttribute("aria-expanded")).toBe("true")
    expect(trigger().getAttribute("aria-controls")).toBe(menu.id)
    expect(trigger().hasAttribute("data-menu-open")).toBe(true)
  })

  it.each([["Enter", "{Enter}"], ["Space", " "], ["ArrowDown", "{ArrowDown}"]])("opens from %s with focus on the first item", async (_name, keys) => {
    render(<Example />)
    await userEvent.tab()
    expect(document.activeElement).toBe(trigger())

    await userEvent.keyboard(keys)

    await screen.findByRole("menu")
    await waitFor(() => expect(document.activeElement).toBe(item("Rename")))
  })

  it("moves through the items with the arrow keys and skips what is disabled", async () => {
    render(<Example />)
    await userEvent.tab()
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(document.activeElement).toBe(item("Rename")))

    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(item("Archive"))
    await userEvent.keyboard("{ArrowDown}")
    expect(document.activeElement).toBe(item("Documentation"))
    await userEvent.keyboard("{ArrowUp}")
    expect(document.activeElement).toBe(item("Archive"))
  })

  it("jumps to the item a typed letter starts", async () => {
    render(<Example />)
    await userEvent.tab()
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(document.activeElement).toBe(item("Rename")))

    await userEvent.keyboard("a")
    expect(document.activeElement).toBe(item("Archive"))
    await pause(1100)
    await userEvent.keyboard("d")
    expect(document.activeElement).toBe(item("Documentation"))
  })

  it("Escape closes it and focus returns to the trigger", async () => {
    const onOpenChange = vi.fn()
    render(<Example onOpenChange={onOpenChange} />)
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("choosing an item runs it, closes the menu and returns focus to the trigger", async () => {
    const onRename = vi.fn()
    render(<Example onRename={onRename} />)
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    await userEvent.click(item("Rename"))

    expect(onRename).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger()))
  })

  it("chooses the focused item with Enter", async () => {
    const onArchive = vi.fn()
    render(<Example onArchive={onArchive} />)
    await userEvent.tab()
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(document.activeElement).toBe(item("Rename")))

    await userEvent.keyboard("{ArrowDown}{Enter}")

    expect(onArchive).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("does not run a disabled item", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    fireEvent.click(item("Delete"))

    expect(screen.queryByRole("menu")).not.toBeNull()
    expect(item("Delete").getAttribute("aria-disabled")).toBe("true")
  })

  it("an item that is a link keeps its address", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    expect(screen.getByRole("menuitem", { name: "Documentation" }).getAttribute("href")).toBe("#docs")
  })

  it("closes on a press outside it, and the press goes on to what it landed on", async () => {
    const onElsewhere = vi.fn()
    render(
      <>
        <Example />
        <button type="button" onClick={onElsewhere}>Elsewhere too</button>
      </>,
    )
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    await userEvent.click(screen.getByRole("button", { name: "Elsewhere too" }))

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(onElsewhere).toHaveBeenCalledTimes(1)
  })

  it("closes on a press on something that cannot take focus, which moves no focus for React Aria to notice", async () => {
    render(
      <>
        <Example />
        <p data-testid="text">Some text</p>
      </>,
    )
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    fireEvent.pointerDown(screen.getByTestId("text"), { button: 0 })

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("is closed by a second press on its trigger, not reopened by it", async () => {
    render(<Example />)
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    await userEvent.click(trigger())

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await pause(150)
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("keeps the menu open when onSelect prevents the default, and closes on the next plain choice", async () => {
    const onKeep = vi.fn((event: Event) => event.preventDefault())
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onKeep}>Toggle</DropdownMenuItem>
          <DropdownMenuItem>Done</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await userEvent.click(trigger())
    await screen.findByRole("menu")

    await userEvent.click(item("Toggle"))
    expect(onKeep).toHaveBeenCalledTimes(1)
    await pause(50)
    expect(screen.queryByRole("menu")).not.toBeNull()

    await userEvent.click(item("Done"))
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("can be controlled with `open` and `onOpenChange`", async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <DropdownMenu open={false} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    )

    await userEvent.click(trigger())
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole("menu")).toBeNull()

    rerender(
      <DropdownMenu open onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    )
    await screen.findByRole("menu")
  })

  it("a disabled trigger opens nothing", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" disabled>Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    )

    fireEvent.pointerDown(trigger(), { button: 0 })
    fireEvent.keyDown(trigger(), { key: "Enter" })

    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("runs the trigger's own handlers first, and a handler that prevents the default stops the menu opening", async () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault())
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" onKeyDown={onKeyDown}>Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuItem>One</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>,
    )
    await userEvent.tab()

    await userEvent.keyboard("{Enter}")

    expect(onKeyDown).toHaveBeenCalled()
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
