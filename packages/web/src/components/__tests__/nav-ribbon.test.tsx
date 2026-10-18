import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { NavRibbon } from "../pill-nav"
import { NAV_ITEMS } from "@/lib/nav"

const prefetchRoute = vi.fn()
vi.mock("@/lib/route-prefetch", () => ({ prefetchRoute: (...args: unknown[]) => prefetchRoute(...args) }))

function renderRibbon(props: { listOpen: boolean; path?: string }) {
  return render(
    <MemoryRouter initialEntries={[props.path ?? "/"]}>
      <NavRibbon listOpen={props.listOpen} onToggleList={vi.fn()} />
    </MemoryRouter>,
  )
}

describe("NavRibbon", () => {
  it("renders a brand-only top slot (no fold toggle) when mounted without list props", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/org"]}>
        <NavRibbon />
      </MemoryRouter>,
    )
    // The global (non-chat) rail has no list to fold → no toggle button.
    expect(screen.queryByLabelText("Show chats")).toBeNull()
    expect(screen.queryByLabelText("Hide chats")).toBeNull()
    // The top slot is a brand mark that links home.
    expect(container.querySelector('a[href="/"]')).toBeTruthy()
  })

  it("renders the toggle with a state-aware label", () => {
    const { rerender } = renderRibbon({ listOpen: true })
    expect(screen.getByLabelText("Hide chats")).toBeTruthy()
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <NavRibbon listOpen={false} onToggleList={vi.fn()} />
      </MemoryRouter>,
    )
    const toggle = screen.getByLabelText("Show chats")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })

  it("renders every nav item as a labelled link", () => {
    renderRibbon({ listOpen: true })
    for (const item of NAV_ITEMS) {
      const link = screen.getByLabelText(item.label)
      expect(link.getAttribute("href")).toBe(item.href)
    }
  })

  it("prefetches a route when its nav link is hovered", () => {
    renderRibbon({ listOpen: true })
    fireEvent.pointerEnter(screen.getByLabelText("Todos"))
    expect(prefetchRoute).toHaveBeenCalledWith("/todos")
  })

  it("marks the active route with aria-current and a non-accent fill", () => {
    renderRibbon({ listOpen: true, path: "/org" })
    const active = screen.getByLabelText("Organization")
    expect(active.getAttribute("aria-current")).toBe("page")
    // Selection is accent-independent: a soft --fill-secondary, never --accent.
    expect(active.className).toContain("fill-secondary")
    expect(active.className).not.toContain("--accent")
    // A non-active item carries no aria-current.
    expect(screen.getByLabelText("Cron").getAttribute("aria-current")).toBeNull()
  })

  it("leaves the workspace and theme controls to the status bar", () => {
    renderRibbon({ listOpen: true })
    const nav = screen.getByRole("navigation", { name: "Primary" })
    expect(within(nav).queryByLabelText("Switch workspace")).toBeNull()
    expect(within(nav).queryByLabelText(/Theme:/)).toBeNull()
  })

  // Chat icon is OPEN-ONLY: reveals a collapsed list while already on /chat,
  // navigates otherwise, never closes.
  describe("Chat icon open-only behavior", () => {
    function renderWith(opts: { listOpen: boolean; path: string; onToggleList: () => void }) {
      render(
        <MemoryRouter initialEntries={[opts.path]}>
          <NavRibbon listOpen={opts.listOpen} onToggleList={opts.onToggleList} />
        </MemoryRouter>,
      )
      return screen.getByLabelText("Chat")
    }

    it("reveals the list when on /chat with the list hidden", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).toHaveBeenCalledTimes(1)
    })

    it("is a no-op when the list is already open on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: true, path: "/", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("navigates (never toggles) when not on /chat", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/org", onToggleList })
      fireEvent.click(chat)
      expect(onToggleList).not.toHaveBeenCalled()
    })

    it("does not hijack modified clicks (new tab / window)", () => {
      const onToggleList = vi.fn()
      const chat = renderWith({ listOpen: false, path: "/", onToggleList })
      fireEvent.click(chat, { metaKey: true })
      expect(onToggleList).not.toHaveBeenCalled()
    })
  })

  describe("the label that reveals beside an icon", () => {
    it("is the visible text of a link that is already named, and stays out of the accessibility tree", () => {
      renderRibbon({ listOpen: true })
      const todos = screen.getByLabelText("Todos")
      const pill = todos.querySelector(".rail-reveal")!

      expect(pill.textContent).toBe("Todos")
      expect(pill.closest("[aria-hidden]")).not.toBeNull()
      // The one name a screen reader gets is the link's own, once.
      expect(screen.getAllByRole("link", { name: "Todos" })).toHaveLength(1)
    })

    it("is shown by CSS alone, so the rail needs no script and no tooltip library", () => {
      renderRibbon({ listOpen: true })
      const pill = screen.getByLabelText("Todos").querySelector(".rail-reveal")!

      expect(pill.className).toContain("opacity-0")
      expect(pill.className).toContain("group-hover/row:opacity-100")
      expect(pill.className).toContain("group-focus-within/row:opacity-100")
    })

    it("is dismissed by Escape on the focused row, and comes back when focus returns", () => {
      renderRibbon({ listOpen: true })
      const todos = screen.getByLabelText("Todos")
      const org = screen.getByLabelText("Organization")
      todos.focus()

      fireEvent.keyDown(document, { key: "Escape" })

      expect(todos.hasAttribute("data-label-dismissed")).toBe(true)
      expect(org.hasAttribute("data-label-dismissed")).toBe(false)
      fireEvent.blur(todos)
      expect(todos.hasAttribute("data-label-dismissed")).toBe(false)
    })

    it("is shown again when keyboard focus lands on a row whose label was dismissed", () => {
      renderRibbon({ listOpen: true })
      const todos = screen.getByLabelText("Todos")
      // Escape while the pointer is over Todos, then Tab to it.
      todos.setAttribute("data-label-dismissed", "")

      todos.focus()

      expect(todos.hasAttribute("data-label-dismissed")).toBe(false)
    })

    it("is shown again when the pointer re-enters a row whose label was dismissed", () => {
      renderRibbon({ listOpen: true })
      const todos = screen.getByLabelText("Todos")
      // jsdom has no hover to dismiss under; mark the row as Escape would.
      todos.setAttribute("data-label-dismissed", "")

      fireEvent.pointerEnter(todos)

      expect(todos.hasAttribute("data-label-dismissed")).toBe(false)
    })

    it("ignores other keys", () => {
      renderRibbon({ listOpen: true })
      const todos = screen.getByLabelText("Todos")
      todos.focus()

      fireEvent.keyDown(document, { key: "Enter" })

      expect(todos.hasAttribute("data-label-dismissed")).toBe(false)
    })
  })
})
