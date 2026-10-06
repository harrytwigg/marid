import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type React from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StartedSession } from "@/lib/api-auto-dispatch"

/**
 * The usage card's account switcher: shown only when the gateway reports more
 * than one Claude account, it reads the picked account's history with
 * `account=` and names it in the title; starts on other accounts are left out.
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
// The chart draws a dot per start; counting them needs no SVG layout.
vi.mock("../usage-chart", () => ({
  UsageChart: ({ starts }: { starts: StartedSession[] }) => <div data-testid="chart-starts">{starts.map((start) => start.id).join(",")}</div>,
}))

import AutoDispatchPage from "../page"

const FRIEND = "claude:ab12cd34"
const accounts = [
  { account: "claude", label: "claude" },
  { account: FRIEND, label: ".claude-friend" },
]

const session = (over: Partial<StartedSession>): StartedSession => ({
  id: "s", engine: "claude", model: "sonnet", employee: "dev", title: "A session", source: "web",
  status: "idle", createdAt: new Date().toISOString(), startedBy: "dispatch", ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  reads.getBoardWalkStatus.mockResolvedValue({
    path: "/p", exists: true, problems: [], retiredKeys: [], job: null, scheduled: false, running: false,
    settings: { employee: "assistant", actions: { release: true, park: true, flagStuck: true, dispatch: false, comment: true } },
  })
  reads.getBoardWalkTicks.mockResolvedValue([])
  reads.getStartedSessions.mockResolvedValue([
    session({ id: "default-no-account" }),
    session({ id: "default-explicit", account: "claude" }),
    session({ id: "friend-start", account: FRIEND }),
  ])
})

const title = () => screen.getByTestId("usage").querySelector("h2")?.textContent

describe("the usage card's account switcher", () => {
  it("is absent, and the title unchanged, with a single Claude account", async () => {
    reads.getUsageSamples.mockResolvedValue({ samples: [] })
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    await screen.findByTestId("usage")
    await waitFor(() => expect(reads.getUsageSamples).toHaveBeenCalled())
    expect(screen.queryByRole("radiogroup", { name: "Claude account" })).toBeNull()
    expect(title()).toBe("Where the Claude allowance is heading")
    // No account filter: every Claude start is drawn.
    expect(screen.getByTestId("chart-starts").textContent).toBe("default-no-account,default-explicit,friend-start")
  })

  it("is absent with a one-entry accounts list", async () => {
    reads.getUsageSamples.mockResolvedValue({ samples: [], account: "claude", accounts: [accounts[0]] })
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    await screen.findByTestId("usage")
    await waitFor(() => expect(reads.getUsageSamples).toHaveBeenCalled())
    expect(screen.queryByRole("radiogroup", { name: "Claude account" })).toBeNull()
  })

  it("shows with several accounts, default selected and named in the title, asking without an account", async () => {
    reads.getUsageSamples.mockResolvedValue({ samples: [], account: "claude", accounts })
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    const group = await screen.findByRole("radiogroup", { name: "Claude account" })
    expect(within(group).getByRole("radio", { name: "claude" }).getAttribute("aria-checked")).toBe("true")
    expect(within(group).getByRole("radio", { name: ".claude-friend" }).getAttribute("aria-checked")).toBe("false")
    expect(title()).toBe("Where the Claude allowance is heading — claude")
    expect(reads.getUsageSamples.mock.calls[0][1]).toBeUndefined()
    // Sessions without an account count as the default.
    expect(screen.getByTestId("chart-starts").textContent).toBe("default-no-account,default-explicit")
  })

  it("refetches with account= on switching, retitles, and keeps only that account's starts", async () => {
    reads.getUsageSamples.mockImplementation(async (_hours: number, account?: string) =>
      ({ samples: [], account: account ?? "claude", accounts }))
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    const group = await screen.findByRole("radiogroup", { name: "Claude account" })
    fireEvent.click(within(group).getByRole("radio", { name: ".claude-friend" }))
    await waitFor(() => expect(reads.getUsageSamples.mock.calls.some((call) => call[1] === FRIEND)).toBe(true))
    await waitFor(() => expect(title()).toBe("Where the Claude allowance is heading — .claude-friend"))
    expect(screen.getByTestId("chart-starts").textContent).toBe("friend-start")
    expect(within(screen.getByRole("radiogroup", { name: "Claude account" })).getByRole("radio", { name: ".claude-friend" }).getAttribute("aria-checked")).toBe("true")

    fireEvent.click(screen.getByRole("radio", { name: "claude" }))
    await waitFor(() => expect(screen.getByTestId("chart-starts").textContent).toBe("default-no-account,default-explicit"))
    expect(reads.getUsageSamples.mock.calls.at(-1)?.[1]).toBeUndefined()
  })
})
