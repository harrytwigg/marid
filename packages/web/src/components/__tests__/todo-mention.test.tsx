import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemOpenDetailWire } from "@/lib/api"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { formatMessage } from "@/components/chat/chat-messages"
import { PeekProvider, usePeekStack, type PeekEntry } from "@/components/peek/peek-stack"
import { forgetTodoPreview } from "@/lib/todo-preview"
import { TodoOpenContext, type OpenTodo } from "@/components/chat/file-open-context"
import { FileLinkSessionContext } from "@/components/chat/file-link-session-context"

const getWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItems: (...args: unknown[]) => getWorkItems(...args),
    },
  }
})

const LIVE_PREFIXES: ReadonlySet<string> = new Set(["ICI"])

/** The batch route answers with only the rows it could resolve, so the stub
 *  echoes back exactly the ids it was asked for unless a case omits some. */
function respondWith(omit: ReadonlySet<string> = new Set()) {
  getWorkItems.mockImplementation((ids: string[]) => Promise.resolve({
    workItems: ids
      .filter((id) => !omit.has(id))
      .map((id) => ({ workItem: { id }, events: [] } as unknown as WorkItemOpenDetailWire)),
  }))
}

function ids(start: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `ICI-${start + i}`)
}

/** Render a chat message the way the transcript does, then drain the coalescer's
 *  microtask flush and its in-flight request before counting calls. */
async function renderMessage(content: string, prefixes: ReadonlySet<string> = LIVE_PREFIXES) {
  const view = render(
    <MemoryRouter initialEntries={["/chat"]}>
      <TodoPrefixContext.Provider value={prefixes}>
        <div data-testid="message">{formatMessage(content)}</div>
      </TodoPrefixContext.Provider>
    </MemoryRouter>,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return view
}

function requestedIds(): string[] {
  return getWorkItems.mock.calls.flatMap((call) => call[0] as string[])
}

beforeEach(() => {
  getWorkItems.mockReset()
  respondWith()
})

describe("TodoMention markup", () => {
  it("renders a live mention as the same anchor the transcript rendered before", async () => {
    await renderMessage("Open ICI-6001")

    const link = screen.getByRole("link", { name: "ICI-6001" })
    expect(link.getAttribute("href")).toBe("/todos/ICI-6001")
    expect(link.getAttribute("title")).toBe("Open ICI-6001")
    expect(link.getAttribute("class")).toBe(
      "text-[var(--system-blue)] underline decoration-[var(--system-blue)]/40 hover:decoration-[var(--system-blue)] underline-offset-2 font-[family-name:var(--font-code)] text-[0.88em]",
    )
  })

  it("leaves an id from an unknown prefix as plain text and asks the gateway nothing", async () => {
    const { container } = await renderMessage("Open ZZZ-6002")

    expect(screen.getByTestId("message").textContent).toBe("Open ZZZ-6002")
    expect(container.querySelector("a")).toBeNull()
    expect(getWorkItems).not.toHaveBeenCalled()
  })
})

describe("TodoMention preview batching", () => {
  it("collects every mention in a message into one request", async () => {
    const twenty = ids(1001, 20)

    await renderMessage(twenty.join(" "))

    expect(getWorkItems).toHaveBeenCalledTimes(1)
    expect(getWorkItems.mock.calls[0][0]).toEqual(twenty)
  })

  it("serves an already-resolved id from cache instead of asking again", async () => {
    const twenty = ids(2001, 20)

    await renderMessage(twenty.join(" "))
    expect(getWorkItems).toHaveBeenCalledTimes(1)

    await renderMessage(twenty.join(" "))

    expect(getWorkItems).toHaveBeenCalledTimes(1)
  })

  it("chunks past the route's 100-id cap rather than sending one request it would reject", async () => {
    const oversized = ids(3001, 150)

    await renderMessage(oversized.join(" "))

    expect(getWorkItems).toHaveBeenCalledTimes(2)
    expect(getWorkItems.mock.calls.map((call) => (call[0] as string[]).length)).toEqual([100, 50])
    expect(requestedIds()).toEqual(oversized)
  })

  it("caches an id the gateway omits so a dangling mention stops re-asking", async () => {
    respondWith(new Set(["ICI-4001"]))

    await renderMessage("ICI-4001")
    await renderMessage("ICI-4001")

    expect(getWorkItems).toHaveBeenCalledTimes(1)
  })

  it("forgets only the id it was told changed", async () => {
    await renderMessage("ICI-5001 ICI-5002")
    expect(getWorkItems).toHaveBeenCalledTimes(1)

    forgetTodoPreview("ICI-5001")
    await renderMessage("ICI-5001 ICI-5002")

    expect(getWorkItems).toHaveBeenCalledTimes(2)
    expect(getWorkItems.mock.calls[1][0]).toEqual(["ICI-5001"])
  })
})

/** Reports where the router went, so a click that navigates is distinguishable
 *  from one the panel intercepted. */
function Location() {
  return <span data-testid="path">{useLocation().pathname}</span>
}

/** Reports the stack the mention pushed into, without mounting the panel. */
function Stack() {
  const opened = usePeekStack()?.entries ?? []
  return <span data-testid="stack">{opened.map((entry: PeekEntry) => entry.id).join(",")}</span>
}

async function renderMention(withProvider: boolean, openTodo: OpenTodo | null = null) {
  const message = (
    <TodoPrefixContext.Provider value={LIVE_PREFIXES}>
      <TodoOpenContext.Provider value={openTodo}>
        <FileLinkSessionContext.Provider value="chat-a">
          <div data-testid="message">{formatMessage("Open ICI-7001")}</div>
        </FileLinkSessionContext.Provider>
      </TodoOpenContext.Provider>
      <Location />
      <Stack />
    </TodoPrefixContext.Provider>
  )
  const view = render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="*" element={withProvider ? <PeekProvider>{message}</PeekProvider> : message} />
      </Routes>
    </MemoryRouter>,
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return view
}

describe("TodoMention click", () => {
  it("opens the panel instead of navigating on a plain left click", async () => {
    await renderMention(true)

    fireEvent.click(screen.getByRole("link", { name: "ICI-7001" }), { button: 0 })

    expect(screen.getByTestId("stack").textContent).toBe("ICI-7001")
    expect(screen.getByTestId("path").textContent).toBe("/chat")
  })

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["the middle button", { button: 1 }],
  ])("leaves %s to the browser rather than opening the panel", async (_name, modifier) => {
    await renderMention(true)
    const link = screen.getByRole("link", { name: "ICI-7001" })

    // Nothing calls preventDefault, so the browser performs its own navigation
    // (new tab / new window) exactly as it did before the panel existed.
    const notPrevented = fireEvent.click(link, modifier)

    expect(notPrevented).toBe(true)
    expect(screen.getByTestId("stack").textContent).toBe("")
    expect(link.getAttribute("href")).toBe("/todos/ICI-7001")
  })

  it("navigates on a surface that mounted no provider", async () => {
    await renderMention(false)

    fireEvent.click(screen.getByRole("link", { name: "ICI-7001" }), { button: 0 })

    expect(screen.getByTestId("path").textContent).toBe("/todos/ICI-7001")
  })
})

describe("TodoMention click in the chat layout", () => {
  it("opens the Todo as a tab beside the chat it was clicked in, not in the panel", async () => {
    const openTodo = vi.fn<OpenTodo>(() => true)
    await renderMention(true, openTodo)

    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "ICI-7001" }), { button: 0 })

    expect(notPrevented).toBe(false)
    expect(openTodo).toHaveBeenCalledWith("ICI-7001", "chat-a")
    expect(screen.getByTestId("stack").textContent).toBe("")
    expect(screen.getByTestId("path").textContent).toBe("/chat")
  })

  it("falls back to the panel when the layout cannot take a tab", async () => {
    const openTodo = vi.fn<OpenTodo>(() => false)
    await renderMention(true, openTodo)

    fireEvent.click(screen.getByRole("link", { name: "ICI-7001" }), { button: 0 })

    expect(openTodo).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("stack").textContent).toBe("ICI-7001")
  })

  it("leaves a modified click to the browser, so the full page is still one ctrl-click away", async () => {
    const openTodo = vi.fn<OpenTodo>(() => true)
    await renderMention(true, openTodo)

    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "ICI-7001" }), { ctrlKey: true })

    expect(notPrevented).toBe(true)
    expect(openTodo).not.toHaveBeenCalled()
  })
})
