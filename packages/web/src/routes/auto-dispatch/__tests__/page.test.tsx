import { fireEvent, render, screen, within } from "@testing-library/react"
import type React from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/api"
import type { BoardWalkStatus, StartedSession, TickRecord } from "@/lib/api-auto-dispatch"

/**
 * The Auto-Dispatch page after the board walk: read-only. It shows the walk's
 * settings and ticks, and every session started per engine whatever started
 * it — a board-walk start and a manual one alike — and has no controls left for
 * the deleted idle-capacity policy.
 */

const reads = vi.hoisted(() => ({
  getBoardWalkStatus: vi.fn(),
  getBoardWalkTicks: vi.fn(),
  getStartedSessions: vi.fn(),
  getUsageSamples: vi.fn(),
}))

vi.mock("@/lib/api-auto-dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auto-dispatch")>()
  return { ...actual, ...reads }
})
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, connected: true }) }))

import AutoDispatchPage from "../page"

const status: BoardWalkStatus = {
  path: "/home/op/.jinn/board-walk.md",
  exists: true,
  settings: {
    enabled: true, schedule: "0 * * * *", timezone: "Europe/London", employee: "assistant", model: "sonnet",
    actions: { release: true, park: true, flagStuck: true, dispatch: false, comment: true },
  },
  problems: [],
  scheduled: true,
  running: false,
}

const tick: TickRecord = {
  at: new Date(Date.now() - 10 * 60_000).toISOString(),
  trigger: "schedule",
  outcome: "ok",
  summary: "1 released. One gate met. Dispatch: dispatch is switched off.",
  sessionId: "walk-1",
  entries: [
    { kind: "release", workItemId: "ABC-7", reason: "not before 30 September has passed", outcome: "moved to backlog" },
    { kind: "hold", reason: "dispatch is switched off", outcome: "dispatch is switched off" },
  ],
}

const session = (over: Partial<StartedSession>): StartedSession => ({
  id: "s", engine: "claude", model: "sonnet", employee: "todo-dispatcher", title: "Dispatch ABC-1", source: "web",
  status: "idle", createdAt: new Date(Date.now() - 30 * 60_000).toISOString(), startedBy: "dispatch", ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  reads.getBoardWalkStatus.mockResolvedValue(status)
  reads.getBoardWalkTicks.mockResolvedValue([tick])
  reads.getStartedSessions.mockResolvedValue([
    session({ id: "walk-start", title: "Dispatch ABC-2", startedBy: "board-walk-dispatch" }),
    session({ id: "manual", title: "Dispatch ABC-3", startedBy: "dispatch" }),
    session({ id: "codex-chat", engine: "codex", employee: "writer", title: "Draft the post", startedBy: "chat" }),
  ])
  reads.getUsageSamples.mockResolvedValue([])
})

describe("the Auto-Dispatch page", () => {
  it("shows the walk's settings and what its last ticks did, with reasons", async () => {
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    const card = await screen.findByTestId("board-walk")
    expect(within(card).getByText("scheduled")).toBeTruthy()
    expect(within(card).getByText("0 * * * *")).toBeTruthy()
    expect(within(card).getByText(/Switched off: dispatch\./)).toBeTruthy()
    expect(within(card).getByText(tick.summary)).toBeTruthy()
    expect(within(card).getByText(/release — moved to backlog: not before 30 September has passed/)).toBeTruthy()
  })

  it("lists every session started on an engine, a board-walk start and a manual one alike, one engine at a time", async () => {
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    const list = await screen.findByTestId("sessions")
    expect(within(list).getAllByTestId("session-row")).toHaveLength(2)
    expect(within(list).getByText("Dispatch ABC-2")).toBeTruthy()
    expect(within(list).getByText("board walk")).toBeTruthy()
    expect(within(list).getByText("Dispatch ABC-3")).toBeTruthy()
    expect(within(list).getByText("dispatch button")).toBeTruthy()

    fireEvent.click(within(list).getByRole("tab", { name: "codex" }))
    expect(within(list).getAllByTestId("session-row")).toHaveLength(1)
    expect(within(list).getByText("Draft the post")).toBeTruthy()
  })

  it("has no controls left for the deleted policy", async () => {
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    await screen.findByTestId("board-walk")
    expect(screen.queryAllByRole("spinbutton")).toEqual([])
    expect(screen.queryAllByRole("switch")).toEqual([])
    expect(screen.queryAllByRole("textbox")).toEqual([])
    expect(screen.queryByText(/tier/i)).toBeNull()
  })

  it("reports a gateway without a board walk as a state, not an error", async () => {
    reads.getBoardWalkStatus.mockRejectedValue(new ApiError(503, "API error: 503"))
    reads.getBoardWalkTicks.mockResolvedValue([])
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    expect(await screen.findByText("The board walk is not running in this gateway.")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
