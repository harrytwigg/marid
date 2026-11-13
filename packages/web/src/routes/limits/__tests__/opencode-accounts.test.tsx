/** Limits page — one card per opencode account, with a window row per metered model. */
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const now = Date.parse("2026-11-12T12:00:00.000Z")
let state: { data: EngineLimitsResponse | null; phase: "ready"; refreshing: boolean; error: string | null; now: number; refresh: () => void }
vi.mock("../use-engine-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../use-engine-limits")>()
  return { ...actual, useEngineLimits: () => state }
})
import LimitsPage from "../page"

const iso = (ms: number) => new Date(now + ms).toISOString()
const HOUR = 3_600_000
const engine = (name: string, over: Partial<EngineLimitEngineSnapshot> = {}): EngineLimitEngineSnapshot => ({
  name, available: true, status: "snapshot", source: "ledger", refreshedAt: iso(0), models: [], ...over,
})
const win = (name: string, mins: number, pct: number) => ({ name, windowDurationMins: mins, usedPercent: pct, resetsAtIso: iso(2 * HOUR) })
const account = (key: string, label: string, over: Partial<EngineLimitAccountSnapshot> = {}): EngineLimitAccountSnapshot => ({
  ...engine("opencode"), account: key, label, location: { kind: "local" }, employees: [], ...over,
})

function show(accounts: EngineLimitAccountSnapshot[]) {
  state = {
    phase: "ready", refreshing: false, error: null, now, refresh: () => {},
    data: { generatedAt: iso(0), default: "claude", engines: { opencode: engine("opencode") }, accounts: { opencode: accounts } },
  }
  return render(<LimitsPage />)
}
const card = (title: string) => screen.getByRole("heading", { level: 2, name: title }).closest("article") as HTMLElement

const GO_B = account("go-b", "Go (second workspace)", {
  provider: "opencode-go-b", base: "opencode-go", keyEnv: "OPENCODE_GO_B_API_KEY", keySet: true,
  buckets: [
    { id: "opencode-go-b/deepseek-v4.1-flash", windows: [win("5h", 300, 12), win("7d", 10080, 40), win("30d", 43200, 95)] },
    { id: "opencode-go-b/mimo-v2.6-pro", windows: [win("30d", 43200, 20)] },
  ],
})
const GO_A = account("go-a", "go-a", { provider: "opencode-go", buckets: [] })

describe("LimitsPage — opencode accounts", () => {
  it("renders one card per account, a window row per window of each metered model, and the key state", () => {
    show([GO_A, GO_B])
    expect(screen.getAllByTestId("engine-card")).toHaveLength(3)   // the engine's own card, then one per account
    const b = card("Go (second workspace)")
    const buckets = Array.from(b.querySelectorAll("[data-bucket]"))
    expect(buckets.map((s) => s.getAttribute("data-bucket"))).toEqual(["opencode-go-b/deepseek-v4.1-flash", "opencode-go-b/mimo-v2.6-pro"])
    expect(within(buckets[0] as HTMLElement).getByRole("heading", { level: 3 }).textContent).toBe("deepseek-v4.1-flash")
    expect(buckets[0].textContent).toContain("5h")
    expect(buckets[0].textContent).toContain("7d")
    expect(buckets[0].textContent).toContain("30d")
    expect(buckets[0].textContent).toContain("95%")
    expect(within(b).getByTestId("key-state").textContent).toBe("Key: OPENCODE_GO_B_API_KEY is set")
    expect(b.textContent).toContain("opencode-go-b · from opencode-go")
  })

  it("names a built-in account as built-in, with no key line", () => {
    show([GO_A, GO_B])
    const a = card("go-a")
    expect(a.textContent).toContain("opencode-go · built-in")
    expect(within(a).queryByTestId("key-state")).toBeNull()
    expect(a.textContent).toContain("No usage limits set on this account.")
  })

  it("says an unset key, holds at limit until the reset, and lists the account's problems", () => {
    show([account("go-b", "Go b", {
      provider: "p", base: "b", keyEnv: "K", keySet: false, buckets: [],
      exhausted: { until: iso(3 * HOUR) }, problems: ['account "go-b" has no key: K is not set'],
    })])
    const c = card("Go b")
    expect(within(c).getByTestId("key-state").textContent).toBe("Key: K is not set")
    expect(c.textContent).toContain("At limit")
    expect(c.textContent).toContain("resets in 3h")
    expect(within(c).getByTestId("account-problem").textContent).toContain("K is not set")
  })

  it("shows the next try while held, and the last failure when present", () => {
    show([account("go-b", "Go b", {
      provider: "p", buckets: [], nextTryAt: iso(90 * 60_000),
      lastFailure: { class: "quota", at: iso(-10 * 60_000), reason: "x" },
    })])
    const c = card("Go b")
    expect(within(c).getByTestId("next-try").textContent).toBe("Next try in 2h")
    expect(within(c).getByTestId("last-failure").textContent).toBe("Last failure: quota, 10m ago")
  })

  it("leaves a card with no failure, no next try and no problems without those rows", () => {
    show([account("go-b", "Go b", { provider: "p", base: "b", keyEnv: "K", keySet: true, buckets: [] })])
    const c = card("Go b")
    for (const id of ["next-try", "last-failure", "account-problem"]) expect(within(c).queryByTestId(id)).toBeNull()
  })

  it("leaves a Claude account card exactly as it was: windows, no model buckets, no facts", () => {
    state = {
      phase: "ready", refreshing: false, error: null, now, refresh: () => {},
      data: { generatedAt: iso(0), default: "claude", engines: { claude: engine("claude") },
        accounts: { claude: [{ ...engine("claude", { windows: [win("5h", 300, 30)] }), account: "claude", label: "Claude", location: { kind: "local" }, employees: [] }] } },
    }
    render(<LimitsPage />)
    expect(screen.queryByTestId("model-buckets")).toBeNull()
    expect(screen.queryByTestId("account-facts")).toBeNull()
    expect(screen.getByText("5h window")).toBeTruthy()
  })

  it("shows only the variable's name when the key state is not reported", () => {
    show([account("go-b", "Go b", { provider: "p", base: "b", keyEnv: "K", buckets: [] })])
    expect(within(card("Go b")).getByTestId("key-state").textContent).toBe("Key: K")
  })

  it("does not call a next try in the past a reset, and names a * bucket as all models", () => {
    show([account("go-b", "Go b", { provider: "p", nextTryAt: iso(-60_000), buckets: [{ id: "p/*", windows: [win("30d", 43200, 5)] }] })])
    const c = card("Go b")
    expect(within(c).getByTestId("next-try").textContent).toBe("Next try now")
    expect(within(c).getByRole("heading", { level: 3 }).textContent).toBe("All models")
  })

  it("keeps the engine card first, with only the buckets no account covers", () => {
    state = {
      phase: "ready", refreshing: false, error: null, now, refresh: () => {},
      data: { generatedAt: iso(0), default: "claude", accounts: { opencode: [GO_A, GO_B] }, engines: { opencode: engine("opencode", { buckets: [
        { id: "opencode-go/*", windows: [win("30d", 43200, 1)] },
        { id: "opencode-go-b/mimo-v2.6-pro", windows: [win("30d", 43200, 2)] },
        { id: "openrouter/*", windows: [win("30d", 43200, 77)] },
      ] }) } },
    }
    render(<LimitsPage />)
    const cards = screen.getAllByTestId("engine-card")
    expect(cards).toHaveLength(3)
    const own = cards[0]
    expect(Array.from(own.querySelectorAll("[data-bucket]")).map((n) => n.getAttribute("data-bucket"))).toEqual(["openrouter/*"])
    expect(own.textContent).toContain("77%")
    expect(within(own).getByRole("heading", { level: 2 }).textContent).toBe("opencode")
  })

  it("shows no figures on the engine card when every metered bucket is an account's", () => {
    state = {
      phase: "ready", refreshing: false, error: null, now, refresh: () => {},
      data: { generatedAt: iso(0), default: "claude", accounts: { opencode: [GO_A, GO_B] }, engines: { opencode: engine("opencode", {
        accountPlan: "opencode-go-b/mimo-v2.6-pro · $0.30/month",
        windows: [win("30d", 43200, 2999)],
        buckets: [
          { id: "opencode-go/*", windows: [win("30d", 43200, 1)] },
          { id: "opencode-go-b/mimo-v2.6-pro", windows: [win("30d", 43200, 2999)] },
        ],
      }) } },
    }
    render(<LimitsPage />)
    const own = screen.getAllByTestId("engine-card")[0]
    expect(within(own).getByRole("heading", { level: 2 }).textContent).toBe("opencode")
    expect(own.querySelectorAll("[data-bucket]")).toHaveLength(0)
    expect(own.textContent).toContain("Nothing metered outside the accounts.")
    expect(own.textContent).not.toContain("2999")
    expect(own.textContent).not.toContain("$0.30/month")
  })

  it("reads a card with nothing metered as Not metered", () => {
    state = {
      phase: "ready", refreshing: false, error: null, now, refresh: () => {},
      data: { generatedAt: iso(0), default: "claude", engines: { opencode: engine("opencode", { status: "unsupported" }) } },
    }
    render(<LimitsPage />)
    expect(screen.getByText("Not metered")).toBeTruthy()
    expect(screen.queryByText("Unsupported")).toBeNull()
  })

  it("lists every problem an account carries, repeats included", () => {
    show([account("go-b", "Go b", { provider: "p", buckets: [], problems: ["one", "two", "two"] })])
    expect(within(card("Go b")).getAllByTestId("account-problem").map((n) => n.textContent)).toEqual(["one", "two", "two"])
  })
})
