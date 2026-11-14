import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getOnboarding = vi.fn()

vi.mock("@/lib/api", () => ({
  api: {
    getOnboarding: (...args: unknown[]) => getOnboarding(...args),
  },
}))

vi.mock("../global-search", () => ({
  GlobalSearch: ({ initialOpen, initialScope, initialQuery }: { initialOpen?: boolean; initialScope?: string; initialQuery?: string }) => (
    <div
      data-testid="global-search"
      data-initial-open={String(Boolean(initialOpen))}
      data-initial-scope={initialScope ?? ""}
      data-initial-query={initialQuery ?? ""}
    />
  ),
}))

vi.mock("../live-stream-widget", () => ({
  LiveStreamWidget: () => <div data-testid="live-stream-widget" />,
}))

vi.mock("../onboarding-wizard", () => ({
  OnboardingWizard: ({ initialVisible }: { initialVisible?: boolean }) => (
    <div data-testid="onboarding-wizard" data-initial-visible={String(Boolean(initialVisible))} />
  ),
}))

import { useSearchOverlay } from "../search-overlay-context"
import { PageLayout } from "../page-layout"

function renderLayout(children: React.ReactNode = <div>Page content</div>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <PageLayout chromeless>{children}</PageLayout>
    </QueryClientProvider>,
  )
}

/** Stands in for the Todos filter row: a page asking for a scoped palette. */
function ScopedSearchOpener() {
  const { openSearch } = useSearchOverlay()
  return <button onClick={() => openSearch({ scope: "todo", query: "r" })}>open scoped search</button>
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/")
  getOnboarding.mockReset()
  getOnboarding.mockResolvedValue({ onboarded: true, needed: false })
})

describe("PageLayout deferred shell widgets", () => {
  it("does not mount search, live stream, or onboarding during the initial render", () => {
    localStorage.setItem("hundredfold-onboarded", "true")

    renderLayout()

    expect(screen.getByText("Page content")).toBeTruthy()
    expect(screen.queryByTestId("global-search")).toBeNull()
    expect(screen.queryByTestId("live-stream-widget")).toBeNull()
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
    expect(getOnboarding).not.toHaveBeenCalled()
  })

  it("mounts the command palette opened on the first command-k press", async () => {
    localStorage.setItem("hundredfold-onboarded", "true")
    renderLayout()

    fireEvent.keyDown(window, { key: "k", metaKey: true })

    const search = await screen.findByTestId("global-search")
    expect(search.getAttribute("data-initial-open")).toBe("true")
  })

  it("mounts the palette opened, scoped and seeded when a page asks for it", async () => {
    localStorage.setItem("hundredfold-onboarded", "true")
    renderLayout(<ScopedSearchOpener />)

    fireEvent.click(screen.getByRole("button", { name: "open scoped search" }))

    const search = await screen.findByTestId("global-search")
    expect(search.getAttribute("data-initial-open")).toBe("true")
    expect(search.getAttribute("data-initial-scope")).toBe("todo")
    expect(search.getAttribute("data-initial-query")).toBe("r")
  })

  it("mounts the live stream widget after the page finishes loading", async () => {
    vi.useFakeTimers()
    try {
      localStorage.setItem("hundredfold-onboarded", "true")
      renderLayout()

      expect(screen.queryByTestId("live-stream-widget")).toBeNull()

      // jsdom reports readyState "complete", so runAfterLoad schedules the
      // deferred timer immediately; dispatching load also covers the
      // not-yet-loaded branch. The async advance flushes the lazy Suspense
      // import that resolves after the widget mounts.
      await act(async () => {
        window.dispatchEvent(new Event("load"))
        await vi.advanceTimersByTimeAsync(2600)
      })

      expect(screen.getByTestId("live-stream-widget")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("imports onboarding only when the gateway says onboarding is needed", async () => {
    getOnboarding.mockResolvedValue({ onboarded: false, needed: true })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    const wizard = await screen.findByTestId("onboarding-wizard")
    expect(wizard.getAttribute("data-initial-visible")).toBe("true")
  })

  it("honors a fresh-workspace onboarding launch even if this origin has stale local state", async () => {
    localStorage.setItem("hundredfold-onboarded", "true")
    window.history.replaceState(null, "", "/?onboarding=1")
    getOnboarding.mockResolvedValue({ onboarded: false, needed: true })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("onboarding-wizard")).toBeTruthy()
  })

  it("does not import onboarding when the gateway is already onboarded", async () => {
    getOnboarding.mockResolvedValue({ onboarded: true, needed: false })

    renderLayout()

    await waitFor(() => expect(getOnboarding).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("onboarding-wizard")).toBeNull()
    await waitFor(() => expect(localStorage.getItem("hundredfold-onboarded")).toBe("true"))
  })
})

describe("PageLayout edge-back arming", () => {
  function setPointer(coarse: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: coarse && query.includes("pointer: coarse"),
        addEventListener() {},
        removeEventListener() {},
      }),
    })
  }

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia")
  })

  it("never mounts the gesture for a fine pointer", () => {
    localStorage.setItem("hundredfold-onboarded", "true")
    setPointer(false)

    // No router in the tree at all: with a fine pointer nothing in the shell
    // reaches for one, which is what "desktop input never arms it" means here.
    renderLayout()

    expect(screen.getByText("Page content")).toBeTruthy()
    expect(screen.queryByTestId("edge-back-layer")).toBeNull()
  })

  it("mounts the gesture for a coarse pointer", () => {
    localStorage.setItem("hundredfold-onboarded", "true")
    setPointer(true)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PageLayout chromeless>
            <div>Page content</div>
          </PageLayout>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // The layer subscribes to the router for the location it snapshots on, so a
    // coarse-pointer shell holds a subscription that the fine-pointer one above
    // renders entirely without. Same tree, one branch apart.
    expect(screen.getByText("Page content")).toBeTruthy()
    expect(() => renderLayout()).toThrow(/Router/)
  })
})
