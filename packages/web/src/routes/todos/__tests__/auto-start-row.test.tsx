import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire } from "@/lib/api"
import { AutoStartRow } from "../task-page/auto-start-row"

/* US5: the per-Todo auto-start switch writes `{ autoStart }` and
 * nothing else, reads "on" when the Todo has no dispatch config, and says when
 * the opt-out label makes the switch moot. */

const authFetch = vi.fn()
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }))

function detail(over: Partial<WorkItemDetailWire> & { dispatchConfig?: unknown } = {}): WorkItemDetailWire {
  return {
    workItem: { id: "PLA-7", title: "Spare-window work", status: "backlog" } as WorkItemDetailWire["workItem"],
    spendUsd: 0,
    events: [],
    ...over,
  } as WorkItemDetailWire
}

function renderRow(d: WorkItemDetailWire) {
  const qc = new QueryClient()
  render(<QueryClientProvider client={qc}><AutoStartRow detail={d} /></QueryClientProvider>)
  return screen.getByRole("switch", { name: "Auto-start this Todo" })
}

beforeEach(() => {
  authFetch.mockReset()
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ dispatchConfig: { autoStart: false } }) })
})

describe("AutoStartRow", () => {
  it("reads on when the Todo has no dispatch config", () => {
    expect(renderRow(detail()).getAttribute("aria-checked")).toBe("true")
  })

  it("reads off when the dispatch config says so", () => {
    expect(renderRow(detail({ dispatchConfig: { autoStart: false, engine: "opencode" } })).getAttribute("aria-checked")).toBe("false")
  })

  it("writes exactly { autoStart: false } to the dispatch-config route, leaving the engine pin alone", async () => {
    fireEvent.click(renderRow(detail({ dispatchConfig: { autoStart: true, engine: "opencode", model: null, skills: [] } })))
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/work-items/PLA-7/dispatch-config")
    expect(init.method).toBe("PUT")
    expect(JSON.parse(init.body as string)).toEqual({ autoStart: false })
  })

  it("says when the opt-out label overrides the switch", () => {
    renderRow(detail({ labels: [{ id: "lbl_1", name: "no-auto-start", color: null, createdAt: "" } as never] }))
    expect(screen.getByTestId("rail-auto-start").textContent).toContain("Off by label")
  })

  it("surfaces a refused write instead of pretending it landed", async () => {
    authFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "requires the operator" }) })
    fireEvent.click(renderRow(detail()))
    await screen.findByText("requires the operator")
  })
})
