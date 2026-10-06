/**
 * Limits page — per-account cards. Without an `accounts` block the page is what
 * it has always been (no group headings, one card per engine); with one, an
 * engine with several accounts is a headed group with a card per account, and
 * each account's own state decides its badge and note.
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

function show(accounts: EngineLimitsResponse["accounts"]) {
  state = {
    phase: "ready", refreshing: false, error: null, now, refresh: () => {},
    data: {
      generatedAt: iso(0),
      default: "claude",
      engines: { claude: engine("claude", { accountPlan: "Max" }), codex: engine("codex") },
      accounts,
    },
  }
  return render(<LimitsPage />)
}

const card = (title: string) => screen.getByRole("heading", { level: 3, name: title }).closest("section") as HTMLElement

describe("LimitsPage — accounts", () => {
  it("renders one card per engine and no group headings without an accounts block", () => {
    const { container } = show(undefined)
    expect(screen.queryAllByTestId("account-group")).toHaveLength(0)
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["claude", "codex"])
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0)
    expect(container.textContent).not.toMatch(/Used by|At limit|Host asleep|No live reading/)
  })

  it("groups an engine with several accounts under its own heading, default first, other engines unchanged", () => {
    show({
      claude: [
        account("claude", "claude", { accountPlan: "Max" }),
        account("claude:ab12cd34", ".claude-friend", { employees: ["side-dev", "side-qa"] }),
      ],
    })
    const [group] = screen.getAllByTestId("account-group")
    expect(within(group).getByRole("heading", { level: 2 }).textContent).toBe("claude")
    expect(within(group).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["claude", ".claude-friend"])
    // codex has one account: a plain card outside the group.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["claude", "codex"])
    expect(within(card(".claude-friend")).getByText("Used by side-dev, side-qa")).toBeTruthy()
    expect(within(card("claude")).queryByText(/Used by/)).toBeNull()
  })

  it("names the host beside the plan on a remote account's card", () => {
    show({
      claude: [
        account("claude", "claude"),
        account("claude@harry@studio", "harry@studio", { accountPlan: "Max", location: { kind: "remote", host: "studio" } }),
      ],
    })
    const remote = card("harry@studio")
    expect(within(remote).getByText("Max")).toBeTruthy()
    expect(within(remote).getByText("on studio")).toBeTruthy()
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
