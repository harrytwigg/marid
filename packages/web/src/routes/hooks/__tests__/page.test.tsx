import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, useLocation } from "react-router-dom"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { sessionPath } from "@/components/chat/chat-route-helpers"
import { ApiError } from "@/lib/api"
import type { BoardHook, HookRun } from "@/lib/api-hooks"

/**
 * The Hooks page: the configured hooks with their enabled switch, and the run
 * log with its filters and expandable rows. The API is mocked, as the gateway
 * side is built in parallel.
 */

const reads = vi.hoisted(() => ({
  listHooks: vi.fn(),
  listHookRuns: vi.fn(),
  getHookRun: vi.fn(),
  setHookEnabled: vi.fn(),
}))

vi.mock("@/lib/api-hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-hooks")>()
  return { ...actual, ...reads }
})
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, connected: true }) }))

import HooksPage from "../page"

beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {}
})

const hook: BoardHook = {
  name: "review-merge",
  enabled: true,
  events: ["todo.status_changed"],
  match: { to: "in_review", label: "auto-merge" },
  actions: [
    { kind: "spawn", employee: "merger" },
    { kind: "notify", connector: "telegram", channel: "123" },
  ],
  allowReentry: false,
  lastFiredAt: new Date(Date.now() - 120_000).toISOString(),
  lastStatus: "ok",
}

const run: HookRun = {
  id: "bhr_1",
  fireId: "bhf_1",
  hook: "review-merge",
  event: "todo.status_changed",
  eventId: "wie_1",
  todoId: "ABC-7",
  action: "spawn",
  status: "ok",
  sessionId: "sess-1",
  exitCode: null,
  error: null,
  chain: ["review-merge"],
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  finishedAt: new Date(Date.now() - 59_000).toISOString(),
}

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

function renderPage(initial = "/hooks") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <HooksPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reads.listHooks.mockResolvedValue({ hooks: [hook], problems: [] })
  reads.listHookRuns.mockResolvedValue({ runs: [run], nextBefore: null })
  reads.getHookRun.mockResolvedValue({ ...run, payload: { version: 1, todo: { id: "ABC-7" } }, output: "merged" })
  reads.setHookEnabled.mockResolvedValue({ ok: true })
})

describe("the Hooks page", () => {
  it("lists the configured hooks and the runs they logged", async () => {
    renderPage()
    const row = await screen.findByTestId("hook-row-review-merge")
    expect(row.textContent).toContain("todo.status_changed · to in_review, label auto-merge")
    expect(row.textContent).toContain("spawn merger · notify telegram:123")
    expect(row.textContent).toContain("fired 2m ago")

    const log = await screen.findByTestId("run-log")
    expect(log.textContent).toContain("review-merge")
    expect(log.textContent).toContain("todo.status_changed")
    expect(log.textContent).toContain("spawn")
    expect(log.textContent).toContain("ok")
  })

  it("links a spawned session and a Todo to their routes", async () => {
    renderPage()
    const details = await screen.findByLabelText("Show details for review-merge")
    const tr = details.closest("tr")!
    const links = Array.from(tr.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain(sessionPath("sess-1"))
    expect(links).toContain("/todos/ABC-7")
  })

  it("toggles a hook off through setHookEnabled and re-reads the list", async () => {
    renderPage()
    const toggle = await screen.findByRole("switch")
    fireEvent.click(toggle)
    await waitFor(() => expect(reads.setHookEnabled).toHaveBeenCalledWith("review-merge", false))
    await waitFor(() => expect(reads.listHooks).toHaveBeenCalledTimes(2))
  })

  it("shows a failed toggle inline, naming the operator-only rule for a 403", async () => {
    reads.setHookEnabled.mockRejectedValue(new ApiError(403, "API error: 403"))
    renderPage()
    fireEvent.click(await screen.findByRole("switch"))
    expect(await screen.findByText("Only the operator can change a hook.")).toBeTruthy()
  })

  it("writes each filter to the URL and passes it to listHookRuns", async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole("combobox", { name: "Filter by hook", hidden: true }))
    await user.click(await screen.findByRole("option", { name: "review-merge" }))
    await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("hook=review-merge"))
    await waitFor(() =>
      expect(reads.listHookRuns).toHaveBeenCalledWith(expect.objectContaining({ hook: "review-merge" }), expect.anything()),
    )

    await user.click(await screen.findByRole("combobox", { name: "Filter by outcome", hidden: true }))
    await user.click(await screen.findByRole("option", { name: "error" }))
    await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("outcome=error"))
    await waitFor(() =>
      expect(reads.listHookRuns).toHaveBeenCalledWith(
        expect.objectContaining({ hook: "review-merge", status: "error" }),
        expect.anything(),
      ),
    )

    fireEvent.change(await screen.findByLabelText("Filter by Todo"), { target: { value: "abc-7" } })
    await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("todo=ABC-7"))
    await waitFor(() =>
      expect(reads.listHookRuns).toHaveBeenCalledWith(
        expect.objectContaining({ hook: "review-merge", status: "error", todo: "ABC-7" }),
        expect.anything(),
      ),
    )
  })

  it("does not send a half-typed Todo to the gateway", async () => {
    renderPage()
    fireEvent.change(await screen.findByLabelText("Filter by Todo"), { target: { value: "abc" } })
    await waitFor(() => expect(screen.getByTestId("search").textContent).toContain("todo=ABC"))
    await waitFor(() => expect(reads.listHookRuns).toHaveBeenCalled())
    expect(reads.listHookRuns).not.toHaveBeenCalledWith(expect.objectContaining({ todo: "ABC" }), expect.anything())
  })

  it("reads the filters back out of the URL on load", async () => {
    renderPage("/hooks?hook=review-merge&outcome=error&todo=ABC-7")
    await waitFor(() =>
      expect(reads.listHookRuns).toHaveBeenCalledWith(
        expect.objectContaining({ hook: "review-merge", status: "error", todo: "ABC-7", limit: 50 }),
        expect.anything(),
      ),
    )
  })

  it("explains an empty hook list rather than showing nothing", async () => {
    reads.listHooks.mockResolvedValue({ hooks: [], problems: [] })
    renderPage()
    const empty = await screen.findByTestId("hooks-empty")
    expect(empty.textContent).toContain("No hooks configured")
    expect(empty.textContent).toContain("hooks:")
    expect(empty.textContent).toContain("docs/board-hooks.md")
  })

  it("warns about hooks the gateway could not read", async () => {
    reads.listHooks.mockResolvedValue({ hooks: [hook], problems: ["hook 'broken': action must name at least one of spawn, command, notify"] })
    renderPage()
    const block = await screen.findByTestId("hooks-problems")
    expect(block.textContent).toContain("hook 'broken': action must name at least one of spawn, command, notify")
  })

  it("reads a run's payload only when its row is opened", async () => {
    renderPage()
    expect(reads.getHookRun).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByLabelText("Show details for review-merge"))
    const payload = await screen.findByTestId("run-payload")
    expect(payload.textContent).toContain('"ABC-7"')
    expect(reads.getHookRun).toHaveBeenCalledWith("bhr_1", expect.anything())
  })
})
