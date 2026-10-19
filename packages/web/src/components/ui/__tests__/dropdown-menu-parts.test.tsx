import "@/test/preload-menus"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../dropdown-menu"

describe("DropdownMenu radio group", () => {
  function Radios({ onValueChange }: { onValueChange: (value: string) => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Mode</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="b" onValueChange={onValueChange} aria-label="Mode">
            <DropdownMenuRadioItem value="a">Alpha</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">Beta</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  it("marks the chosen value and reports a choice, even of the value already chosen", async () => {
    const onValueChange = vi.fn()
    render(<Radios onValueChange={onValueChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Mode" }))
    await screen.findByRole("menu")

    expect(screen.getByRole("menuitemradio", { name: "Beta" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByRole("menuitemradio", { name: "Alpha" }).getAttribute("aria-checked")).toBe("false")

    await userEvent.click(screen.getByRole("menuitemradio", { name: "Alpha" }))
    expect(onValueChange).toHaveBeenLastCalledWith("a")
  })

  it("reports a choice of the value that is already chosen", async () => {
    const onValueChange = vi.fn()
    render(<Radios onValueChange={onValueChange} />)
    await userEvent.click(screen.getByRole("button", { name: "Mode" }))
    await screen.findByRole("menu")

    await userEvent.click(screen.getByRole("menuitemradio", { name: "Beta" }))

    expect(onValueChange).toHaveBeenLastCalledWith("b")
  })
})

describe("DropdownMenu submenus", () => {
  function Nested({ onPick }: { onPick: () => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Filter</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Plain</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Source</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={onPick}>Chat</DropdownMenuItem>
              <DropdownMenuItem>Cron</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  it("opens a submenu with ArrowRight, moves into it, and ArrowLeft closes it again", async () => {
    render(<Nested onPick={vi.fn()} />)
    await userEvent.tab()
    await userEvent.keyboard("{ArrowDown}{ArrowDown}")
    const source = await screen.findByRole("menuitem", { name: "Source" })
    await waitFor(() => expect(document.activeElement).toBe(source))
    expect(source.getAttribute("aria-haspopup")).toBeTruthy()

    await userEvent.keyboard("{ArrowRight}")

    await screen.findByRole("menuitem", { name: "Chat" })
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Chat" })))

    await userEvent.keyboard("{ArrowLeft}")

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Chat" })).toBeNull())
    expect(screen.queryByRole("menu")).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Source" })))
  })

  it("a press inside a submenu is not a press outside the menu, and choosing there closes all of it", async () => {
    const onPick = vi.fn()
    render(<Nested onPick={onPick} />)
    await userEvent.click(screen.getByRole("button", { name: "Filter" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Source" }))
    const chat = await screen.findByRole("menuitem", { name: "Chat" })

    await userEvent.click(chat)

    expect(onPick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
  })

  it("opens a submenu when the pointer rests on its item", async () => {
    render(<Nested onPick={vi.fn()} />)
    await userEvent.click(screen.getByRole("button", { name: "Filter" }))
    const source = await screen.findByRole("menuitem", { name: "Source" })

    await userEvent.hover(source)

    await screen.findByRole("menuitem", { name: "Cron" })
  })
})

describe("DropdownMenu Escape in a submenu", () => {
  it("closes the whole menu, as the Radix menu did, from the keyboard inside the submenu", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Filter</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Source</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Chat</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    await userEvent.tab()
    await userEvent.keyboard("{ArrowDown}")
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Chat" })))

    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter" })))
  })
})
