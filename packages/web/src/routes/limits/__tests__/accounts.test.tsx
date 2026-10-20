/**
 * Limits page — the flat card grid. One card per configured agent: the engine
 * itself, or one card per account (engine + profile) when it has several. No
 * group headings and no "other engines" section: the grid is the layout.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const now = Date.parse("2026-10-06T12:00:00.000Z")
let state: {
  data: EngineLimitsResponse | null
  phase: "loading" | "ready"
  refreshing: boolean
  error: string | null
  now: number
  refresh: () => void
}
vi.mock("../use-engine-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-engine-limits")>()
  return { ...actual, useEngineLimits: () => state }
})

import LimitsPage from "../page"

const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const HOUR = 3_600_000

const engine = (name: string, over: Partial<EngineLimitEngineSnapshot> = {}): EngineLimitEngineSnapshot => ({
  name, available: true, status: "live", source: "x", refreshedAt: iso(0), models: [],
  windows: [{ name: "5h", usedPercent: 40, windowDurationMins: 300, resetsAtIso: iso(2 * HOUR) }],
  ...over,
})

const account = (key: string, label: string, over: Partial<EngineLimitAccountSnapshot> = {}): EngineLimitAccountSnapshot => ({
  ...engine("claude"), account: key, label, location: { kind: "local" }, employees: [], ...over,
})

function show(accounts: EngineLimitsResponse["accounts"], engines: EngineLimitsResponse["engines"] = { claude: engine("claude", { accountPlan: "Max" }), codex: engine("codex") }) {
  state = {
    phase: "ready", refreshing: false, error: null, now, refresh: () => {},
    data: { generatedAt: iso(0), default: "claude", engines, accounts },
  }
  return render(<LimitsPage />)
}

const card = (title: string) => screen.getByRole("heading", { level: 2, name: title }).closest("article") as HTMLElement

describe("LimitsPage — cards", () => {
  it("renders one card per engine in a single flat grid, with no group headings", () => {
    const { container } = show(undefined)
    expect(screen.queryAllByTestId("account-group")).toHaveLength(0)
    expect(screen.queryAllByTestId("other-engines")).toHaveLength(0)
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Claude", "Codex"])
    const grid = container.querySelector('[data-testid="limits-grid"]') as HTMLElement
    expect(within(grid).getAllByTestId("engine-card")).toHaveLength(2)
    for (const item of Array.from(grid.children)) expect(item.tagName).toBe("ARTICLE")
    expect(container.textContent).not.toMatch(/Used by|At limit|Host asleep|No live reading/)
  })

  it("gives an engine with several accounts one card each, default first, in the same grid", () => {
    const { container } = show({
      claude: [
        account("claude", "claude", { accountPlan: "Max" }),
        account("claude:ab12cd34", ".claude-friend", { employees: ["side-dev", "side-qa"] }),
      ],
    })
    expect(screen.queryAllByTestId("account-group")).toHaveLength(0)
    expect(screen.queryAllByTestId("other-engines")).toHaveLength(0)
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Claude", ".claude-friend", "Codex"])
    expect(container.querySelector('[data-testid="limits-grid"]')!.children).toHaveLength(3)
    expect(within(card(".claude-friend")).getByText("Used by side-dev, side-qa")).toBeTruthy()
    expect(within(card("Claude")).queryByText(/Used by/)).toBeNull()
  })

  it("spells an engine the way the project does — 'Muse Code', lowercase 'opencode'", () => {
    show(
      {
        musecode: [
          account("musecode", "musecode", { name: "musecode" }),
          account("musecode:ab12cd34", ".muse-work", { name: "musecode" }),
        ],
      },
      { musecode: engine("musecode"), opencode: engine("opencode") },
    )
    expect(screen.getAllByText("Muse Code")).toHaveLength(2)
    expect(screen.getByText("opencode")).toBeTruthy()
    expect(screen.queryByText("Musecode")).toBeNull()
    expect(screen.queryByText("Opencode")).toBeNull()
  })

  it("names the engine above a profile card and the host beside the plan", () => {
    show({
      claude: [
        account("claude", "claude"),
        account("claude@harry@studio", "harry@studio", { accountPlan: "Max", location: { kind: "remote", host: "studio" } }),
      ],
    })
    const remote = card("harry@studio")
    expect(within(remote).getAllByText("Claude").length).toBeGreaterThan(0)
    expect(within(remote).getByText("Max")).toBeTruthy()
    expect(within(remote).getByText("on studio")).toBeTruthy()
  })

  it("shows each window's meter and reset time on the card", () => {
    show(undefined)
    const claude = card("Claude")
    expect(within(claude).getByText("5h window")).toBeTruthy()
    expect(within(claude).getByText("40%")).toBeTruthy()
    expect(within(claude).getByText("resets in 2h")).toBeTruthy()
  })

  it("marks an account at its limit, with when it resets", () => {
    show({
      claude: [account("claude", "claude"), account("claude:ab12cd34", ".claude-friend", { exhausted: { until: iso(3 * HOUR) } })],
    })
    const friend = card(".claude-friend")
    expect(within(friend).getByText("At limit")).toBeTruthy()
    expect(within(friend).getByText("Recorded at its limit — resets in 3h.")).toBeTruthy()
  })

  it("marks an account with no reading, and shows the empty windows copy", () => {
    show({
      claude: [account("claude", "claude"), account("claude:ab12cd34", ".claude-friend", { noReading: true, windows: [], refreshedAt: "" })],
    })
    const friend = card(".claude-friend")
    expect(within(friend).getByText("No live reading")).toBeTruthy()
    expect(within(friend).getByText(/No live reading yet — this account’s token has expired or it has not been read\. A session on it refreshes the reading\./)).toBeTruthy()
    expect(within(friend).getByText("No quota windows observed yet.")).toBeTruthy()
  })

  it("marks a sleeping host with the age of its last reading, never its raw error or wake text", () => {
    show({
      claude: [
        account("claude", "claude"),
        account("claude@harry@studio", "harry@studio", {
          location: { kind: "remote", host: "studio" }, hostUnreachable: true, status: "snapshot",
          refreshedAt: iso(-2 * HOUR), error: "ssh: connect to host studio port 22: Operation timed out",
        }),
      ],
    })
    const remote = card("harry@studio")
    expect(within(remote).getByText("Host asleep · 2h ago")).toBeTruthy()
    expect(within(remote).getByText("The host is asleep or unreachable; showing the last reading.")).toBeTruthy()
    expect(remote.textContent).not.toMatch(/ssh|timed out|wake/i)
    expect(within(remote).getByText("40%")).toBeTruthy()
  })

  it("says only 'Host asleep' when the host has no last reading", () => {
    show({
      claude: [account("claude", "claude"), account("claude@u@h", "u@h", { location: { kind: "remote", host: "h" }, hostUnreachable: true, refreshedAt: iso(0), windows: [] })],
    })
    expect(within(card("u@h")).getByText("Host asleep")).toBeTruthy()
  })

  it("shows the ordinary freshness badge when no account flag is set", () => {
    show({ claude: [account("claude", "claude"), account("claude:ab12cd34", ".claude-friend")] })
    expect(within(card(".claude-friend")).getByText("Live")).toBeTruthy()
  })

  describe("precedence: at limit, then host asleep, then no live reading", () => {
    const flags = (over: Partial<EngineLimitAccountSnapshot>) =>
      show({ claude: [account("claude", "claude"), account("claude@u@h", "u@h", { location: { kind: "remote", host: "h" }, ...over })] })

    it("at limit beats host asleep and no reading", () => {
      flags({ exhausted: { until: iso(HOUR) }, hostUnreachable: true, noReading: true })
      const remote = card("u@h")
      expect(within(remote).getByText("At limit")).toBeTruthy()
      expect(remote.textContent).not.toMatch(/Host asleep|No live reading/)
    })

    it("host asleep beats no reading", () => {
      flags({ hostUnreachable: true, noReading: true })
      const remote = card("u@h")
      expect(within(remote).getByText(/^Host asleep/)).toBeTruthy()
      expect(remote.textContent).not.toMatch(/No live reading/)
    })

    it("at limit without a reset time still reads cleanly", () => {
      flags({ exhausted: {} })
      expect(within(card("u@h")).getByText("Recorded at its limit.")).toBeTruthy()
    })
  })
})
