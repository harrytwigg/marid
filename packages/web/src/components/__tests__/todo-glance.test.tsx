import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemOpenDetailWire, WorkItemStatusWire } from "@/lib/api"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { PeekProvider, usePeekStack } from "@/components/peek/peek-stack"
import { TodoMention } from "@/components/todo-mention"
import { forgetTodoPreview } from "@/lib/todo-preview"

const getWorkItems = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: { ...actual.api, getWorkItems: (...args: unknown[]) => getWorkItems(...args) },
  }
})

const LIVE_PREFIXES: ReadonlySet<string> = new Set(["ICI"])

/** What the batch route answers with, keyed by id. Ids are unique per case, so
 *  the module-level preview cache never carries an answer between them. */
const rows = new Map<string, { title: string; status: WorkItemStatusWire }>()

let queryClient: QueryClient

/** Stands in for the panel's own close control, so a case can put the stack back
 *  the way it was without mounting the panel itself. */
function ClosePeek() {
  const peek = usePeekStack()
  return <button onClick={() => peek?.close()}>close peek</button>
}

function renderMentions(ids: string[], prefixes: ReadonlySet<string> = LIVE_PREFIXES, withPeek = false) {
  const mentions = (
    <TodoPrefixContext.Provider value={prefixes}>
      {ids.map((id) => <TodoMention key={id} id={id} />)}
      {withPeek && <ClosePeek />}
    </TodoPrefixContext.Provider>
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        {withPeek ? <PeekProvider>{mentions}</PeekProvider> : mentions}
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Focusing the mention is how a keyboard opens the glance, and the one opening
 *  gesture jsdom models faithfully — pointer hover is checked in the browser. */
async function openGlance(id: string) {
  fireEvent.focus(screen.getByRole("link", { name: id }))
  await screen.findByText(rows.get(id)!.title)
}

function stripFor(title: string): HTMLElement {
  const strips = [...document.querySelectorAll<HTMLElement>(".todo-glance")]
  return strips.find((strip) => strip.textContent?.includes(title))!
}

function settle() {
  return act(async () => { await Promise.resolve() })
}

/** Long enough that a viewport which does get the glance would have opened it —
 *  without this the narrow-viewport case would pass on the open delay alone. */
function pastTheOpenDelay() {
  return act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
}

function forceNarrowViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(max-width: 640px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
}

const originalMatchMedia = window.matchMedia

beforeEach(() => {
  rows.clear()
  getWorkItems.mockReset()
  getWorkItems.mockImplementation((ids: string[]) => Promise.resolve({
    workItems: ids.filter((id) => rows.has(id)).map((id) => ({
      workItem: { id, title: rows.get(id)!.title, status: rows.get(id)!.status },
      events: [],
    } as unknown as WorkItemOpenDetailWire)),
  }))
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

describe("the hover glance on a Todo mention", () => {
  it("shows the state disc, the id, the title and the status label of that Todo", async () => {
    rows.set("ICI-7101", { title: "Hover glance strip", status: "executing" })
    renderMentions(["ICI-7101"])

    await openGlance("ICI-7101")

    const strip = stripFor("Hover glance strip")
    expect(strip.textContent).toBe("ICI-7101Hover glance stripIn progress")
    expect(strip.querySelector("svg")).not.toBeNull()
  })

  it("shows nothing and asks the gateway nothing for an unknown prefix", async () => {
    const { container } = renderMentions(["ZZZ-7102"])
    await settle()

    expect(container.textContent).toBe("ZZZ-7102")
    expect(container.querySelector("a")).toBeNull()
    expect(getWorkItems).not.toHaveBeenCalled()
    expect(document.querySelector(".todo-glance")).toBeNull()
  })

  it("opens on an already-warmed id without a second request", async () => {
    rows.set("ICI-7103", { title: "Warmed already", status: "backlog" })
    renderMentions(["ICI-7103"])
    await waitFor(() => expect(getWorkItems).toHaveBeenCalledTimes(1))

    await openGlance("ICI-7103")

    expect(getWorkItems).toHaveBeenCalledTimes(1)
  })

  it("re-reads the hovered id when the gateway says it changed, and leaves the others alone", async () => {
    rows.set("ICI-7104", { title: "Before the event", status: "backlog" })
    rows.set("ICI-7105", { title: "Untouched neighbour", status: "done" })
    renderMentions(["ICI-7104", "ICI-7105"])
    await openGlance("ICI-7104")
    await openGlance("ICI-7105")

    // What use-query-invalidation does for a live work-item event, verbatim.
    rows.set("ICI-7104", { title: "After the event", status: "done" })
    forgetTodoPreview("ICI-7104")
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["work-item-preview", "ICI-7104"] })
    })

    expect(await screen.findByText("After the event")).toBeTruthy()
    expect(screen.queryByText("Before the event")).toBeNull()
    expect(screen.getByText("Untouched neighbour")).toBeTruthy()
    expect(getWorkItems.mock.calls.at(-1)![0]).toEqual(["ICI-7104"])
  })

  it("does not render at all on a narrow viewport, and the mention still navigates", async () => {
    forceNarrowViewport()
    rows.set("ICI-7106", { title: "Not on a phone", status: "backlog" })
    renderMentions(["ICI-7106"])

    const link = screen.getByRole("link", { name: "ICI-7106" })
    fireEvent.focus(link)
    await pastTheOpenDelay()

    expect(document.querySelector(".todo-glance")).toBeNull()
    expect(screen.queryByText("Not on a phone")).toBeNull()
    expect(link.getAttribute("href")).toBe("/todos/ICI-7106")
  })

  it("closes on Escape and leaves focus on the mention", async () => {
    rows.set("ICI-7107", { title: "Escape closes it", status: "backlog" })
    renderMentions(["ICI-7107"])
    await openGlance("ICI-7107")
    const link = screen.getByRole("link", { name: "ICI-7107" })
    link.focus()

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(screen.queryByText("Escape closes it")).toBeNull())
    expect(document.activeElement).toBe(link)
  })

  // The strip portals to the body, so the panel opening beside it takes nothing
  // away, and a hover card has no reason of its own to close on a click that
  // leaves the cursor exactly where it was. Left alone, both stay on screen
  // saying the same thing, the strip lying across the transcript.
  it("takes the strip away when the click opens the peek panel instead", async () => {
    rows.set("ICI-7109", { title: "Peek takes it from here", status: "executing" })
    renderMentions(["ICI-7109"], LIVE_PREFIXES, true)
    await openGlance("ICI-7109")

    fireEvent.click(screen.getByRole("link", { name: "ICI-7109" }), { button: 0 })

    await waitFor(() => expect(document.querySelector(".todo-glance")).toBeNull())
  })

  // Closing it once is not enough: the click leaves the cursor exactly where it
  // was, so the trigger is still engaged and asks to open again the moment its
  // delay elapses. Until the pointer actually leaves, the answer stays no.
  it("keeps the strip away while the mention it opened is still under the cursor", async () => {
    rows.set("ICI-7110", { title: "Still under the cursor", status: "executing" })
    renderMentions(["ICI-7110"], LIVE_PREFIXES, true)
    await openGlance("ICI-7110")
    const link = screen.getByRole("link", { name: "ICI-7110" })

    fireEvent.click(link, { button: 0 })
    fireEvent.focus(link)
    await pastTheOpenDelay()

    expect(document.querySelector(".todo-glance")).toBeNull()
  })

  it("shows the strip again once the panel has moved off that Todo", async () => {
    rows.set("ICI-7111", { title: "Back for a second look", status: "backlog" })
    renderMentions(["ICI-7111"], LIVE_PREFIXES, true)
    await openGlance("ICI-7111")
    fireEvent.click(screen.getByRole("link", { name: "ICI-7111" }), { button: 0 })

    fireEvent.click(screen.getByRole("button", { name: "close peek" }))
    await openGlance("ICI-7111")

    expect(stripFor("Back for a second look")).toBeTruthy()
  })

  it("holds nothing focusable, so tabbing never stops inside it", async () => {
    rows.set("ICI-7108", { title: "Nothing to tab to", status: "in_review" })
    renderMentions(["ICI-7108"])
    await openGlance("ICI-7108")

    const strip = stripFor("Nothing to tab to")
    expect(strip.querySelectorAll("a, button, input, select, textarea, [tabindex]")).toHaveLength(0)
  })
})
