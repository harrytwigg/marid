import "@/test/preload-menus"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearHostBridge, registerHostNotificationSink } from "@/plugins/sdk/host-bridge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../dropdown-menu"
import { preloadMenuPopup } from "../menu-root"

// The popup module is where React Aria's Menu lives (preloaded here, so a menu opens synchronously; the cold
// first open is checked in a real browser by e2e/ui-capture/menus.mjs). A load that fails (a chunk a deploy has removed) reaches
// the page the way a render error in the popup does: through the boundary that closes the menu. The popup here
// throws while `control.fail` is set.
const control = vi.hoisted(() => ({ fail: true }))

vi.mock("../menu-popup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../menu-popup")>()
  const Popup = (props: React.ComponentProps<typeof actual.default>) => {
    if (control.fail) throw new Error("chunk gone")
    return <actual.default {...props} />
  }
  return { PARTS: actual.PARTS, default: Popup }
})

function Example({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button">Actions</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

afterEach(() => {
  control.fail = true
  clearHostBridge()
  vi.restoreAllMocks()
})

describe("a menu whose popup fails", () => {
  it("closes instead of breaking the page, and opens normally once the popup can be loaded", async () => {
    // React logs the error the boundary catches.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onOpenChange = vi.fn()
    const notice = vi.fn()
    registerHostNotificationSink(notice)
    render(<Example onOpenChange={onOpenChange} />)
    const trigger = screen.getByRole("button", { name: "Actions" })

    await userEvent.click(trigger)

    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false))
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(notice).toHaveBeenCalledWith({ title: "The menu couldn't load. Reload the page and try again.", level: "error" })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(trigger.getAttribute("aria-expanded")).toBe("false")

    control.fail = false
    await userEvent.click(trigger)

    await screen.findByRole("menu", { name: "Actions" })
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy()
  })

  it("does not retry on its own: a popup that keeps failing is tried once per open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onOpenChange = vi.fn()
    render(<Example onOpenChange={onOpenChange} />)

    await userEvent.click(screen.getByRole("button", { name: "Actions" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(false))
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(onOpenChange.mock.calls).toEqual([[true], [false]])
  })

  it("loads the popup once, however often it is preloaded", async () => {
    const first = await preloadMenuPopup()
    expect(first).toBeTruthy()
    expect(await preloadMenuPopup()).toBe(first)
  })
})
