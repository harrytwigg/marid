import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type React from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IdleCapacityPolicy, IdleCapacityPreview } from "@/lib/api-idle-capacity"
import { CONFIG_COMMIT_DEBOUNCE_MS } from "@/routes/settings/use-config-commit"

/**
 * The Auto-Dispatch page's write path (US1). What it must never do:
 * write per keystroke, write before it holds the config revision, or drop an
 * edit queued behind a save. What it must do: show the gateway's refusal on
 * the field the refusal names.
 */

const apiMocks = vi.hoisted(() => ({ updateConfig: vi.fn() }))
const reads = vi.hoisted(() => ({
  getIdleCapacityPolicy: vi.fn(),
  getIdleCapacityPreview: vi.fn(),
  getIdleCapacityHistory: vi.fn(),
  getIdleCapacityUsage: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: apiMocks }
})
vi.mock("@/lib/api-idle-capacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-idle-capacity")>()
  return { ...actual, ...reads }
})
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/hooks/use-gateway", () => ({ useGateway: () => ({ connectionSeq: 1, connected: true }) }))

import AutoDispatchPage from "../page"

const tier = (max: number) => ({
  enabled: true,
  fiveHour: { maxUsedPercent: max, lookaheadMinutes: 120 },
  sevenDay: { maxUsedPercent: 75, lookaheadMinutes: 1440 },
  maxDispatchesPerWindow: 2,
  maxActiveSessions: 1,
})
const policy: IdleCapacityPolicy = {
  enabled: false,
  intervalMinutes: 10,
  timezone: "Europe/London",
  quietHours: { start: "01:00", end: "06:00" },
  operatorActivity: { idleMinutes: 30, usageDeltaPercent: 2 },
  tiers: { overnight: tier(85), daytime: tier(50), interactive: tier(20) },
  requireLabel: null,
}
const preview: IdleCapacityPreview = {
  policy, tier: "daytime", reason: "disabled", skipped: [], eligible: [], startedThisWindow: 0,
  operator: { live: false }, quietHours: false,
}

let releasePolicy: (() => void) | null = null

beforeEach(() => {
  vi.clearAllMocks()
  releasePolicy = null
  reads.getIdleCapacityPolicy.mockImplementation(
    () => new Promise((resolve) => {
      releasePolicy = () => resolve({ policy, configured: null, revision: "rev-1" })
    }),
  )
  reads.getIdleCapacityPreview.mockResolvedValue(preview)
  reads.getIdleCapacityHistory.mockResolvedValue([])
  reads.getIdleCapacityUsage.mockResolvedValue([])
  apiMocks.updateConfig.mockResolvedValue({ revision: "rev-2" })
})

async function renderPage() {
  render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
  await waitFor(() => expect(reads.getIdleCapacityPolicy).toHaveBeenCalled())
  releasePolicy!()
  return screen.findByRole("spinbutton", { name: "Daytime five-hour ceiling" })
}

function afterTheWindow() {
  return new Promise((resolve) => setTimeout(resolve, CONFIG_COMMIT_DEBOUNCE_MS + 200))
}

// Real timers: each case waits out the commit debounce at least once, and the
// queued-edit case three times, so the default 5 s is too tight under a full run.
describe("the policy form's writes", { timeout: 20_000 }, () => {
  it("does not write while typing; a blur writes the block once, with the revision it was read under", async () => {
    const ceiling = await renderPage()
    fireEvent.change(ceiling, { target: { value: "4" } })
    fireEvent.change(ceiling, { target: { value: "40" } })
    await afterTheWindow()
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()

    fireEvent.blur(ceiling)
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))
    const [document, revision] = apiMocks.updateConfig.mock.calls[0]
    expect(Object.keys(document as object)).toEqual(["gateway"])
    expect((document as any).gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent).toBe(40)
    expect((document as any).gateway.idleCapacity.tiers.overnight.fiveHour.maxUsedPercent).toBe(85)
    expect(revision).toBe("rev-1")
  })

  it("commits a toggle on click and an Enter in a field", async () => {
    const ceiling = await renderPage()
    fireEvent.click(screen.getByRole("switch", { name: "Idle-capacity auto-start enabled" }))
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))
    expect((apiMocks.updateConfig.mock.calls[0][0] as any).gateway.idleCapacity.enabled).toBe(true)

    fireEvent.change(ceiling, { target: { value: "45" } })
    fireEvent.keyDown(ceiling, { key: "Enter" })
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(2))
    expect((apiMocks.updateConfig.mock.calls[1][0] as any).gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent).toBe(45)
  })

  it("writes nothing for a blank field and says so", async () => {
    const ceiling = await renderPage()
    fireEvent.change(ceiling, { target: { value: "" } })
    fireEvent.blur(ceiling)
    await afterTheWindow()
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
    expect(screen.getByText(/needs a number/)).toBeTruthy()
  })

  it("refuses an edit until the config revision is held", async () => {
    render(<MemoryRouter><AutoDispatchPage /></MemoryRouter>)
    await waitFor(() => expect(reads.getIdleCapacityPolicy).toHaveBeenCalled())
    // The policy has not arrived: no form, so no field to edit and nothing on the wire.
    expect(screen.queryByRole("spinbutton", { name: "Daytime five-hour ceiling" })).toBeNull()
    await afterTheWindow()
    expect(apiMocks.updateConfig).not.toHaveBeenCalled()
  })

  it("shows the gateway's refusal on the field it names, and the file is untouched", async () => {
    const { ApiError } = await import("@/lib/api")
    apiMocks.updateConfig.mockRejectedValueOnce(new ApiError(400,
      "Invalid config: gateway.idleCapacity.tiers.daytime.fiveHour.maxUsedPercent must be a number between 0 and 100 (got 120)"))
    const ceiling = await renderPage()
    fireEvent.change(ceiling, { target: { value: "120" } })
    fireEvent.blur(ceiling)
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))
    // Both the status pill and the field carry the message; the field's is the
    // one the operator needs, and it has to be on the right field.
    const alert = await screen.findByText("must be a number between 0 and 100 (got 120)")
    expect(alert.closest("label")?.textContent).toContain("5h ceiling %")
    expect(screen.getByTestId("tier-daytime").textContent).toContain("must be a number")
    expect(screen.getByTestId("tier-overnight").textContent).not.toContain("must be a number")
  })

  it("keeps an edit queued behind a save: the second field's write goes out after the first resolves", async () => {
    let resolveFirst: (value: { revision: string }) => void = () => {}
    apiMocks.updateConfig
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ revision: "rev-3" })
    const ceiling = await renderPage()
    fireEvent.change(ceiling, { target: { value: "40" } })
    fireEvent.blur(ceiling)
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1))

    const lookahead = screen.getByRole("spinbutton", { name: "Daytime five-hour lookahead" })
    fireEvent.change(lookahead, { target: { value: "90" } })
    fireEvent.blur(lookahead)
    await afterTheWindow()
    // Still in flight: the second edit waits behind it rather than racing it.
    expect(apiMocks.updateConfig).toHaveBeenCalledTimes(1)

    resolveFirst({ revision: "rev-2" })
    await waitFor(() => expect(apiMocks.updateConfig).toHaveBeenCalledTimes(2))
    const [second, revision] = apiMocks.updateConfig.mock.calls[1]
    expect((second as any).gateway.idleCapacity.tiers.daytime.fiveHour).toEqual({ maxUsedPercent: 40, lookaheadMinutes: 90 })
    expect(revision).toBe("rev-2")
    // And the policy was not re-read after the save — that is what would have dropped it.
    expect(reads.getIdleCapacityPolicy).toHaveBeenCalledTimes(1)
  })
})
