import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"
import { NeedsYouView } from "../needs-you-view"

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const getWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()
const setWorkItemStatus = vi.fn()

let restoreTransport: (() => void) | null = null

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getWorkItemTree: (...a: unknown[]) => getWorkItemTree(...a),
      getWorkItems: (...a: unknown[]) => getWorkItems(...a),
      getWorkItemTrees: (...a: unknown[]) => getWorkItemTrees(...a),
      setWorkItemStatus: (...a: unknown[]) => setWorkItemStatus(...a),
    },
  }
})

function item(
  id: string,
  status: WorkItemStatusWire,
  over: Partial<WorkItemCompactWire> = {},
): WorkItemCompactWire {
  return {
    id,
    title: "Review this Todo",
    status,
    department: null,
    assignee: null,
    source: "cron",
    sourceRef: "cron:job:2026",
    updatedAt: "2026-07-05T11:00:00.000Z",
    ...over,
  }
}

function renderView(items: WorkItemCompactWire[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NeedsYouView
          items={items}
          byName={new Map()}
          onOpen={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: "https://qa-a.example:7779",
    request: vi.fn(),
    navigate: vi.fn(),
  }))
  vi.clearAllMocks()
  getWorkItem.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
  getWorkItemTree.mockRejectedValue(Object.assign(new Error("nf"), { status: 404 }))
  getWorkItems.mockResolvedValue({ workItems: [] })
  getWorkItemTrees.mockResolvedValue({ trees: {} })
})

afterEach(() => {
  restoreTransport?.()
  restoreTransport = null
})

describe("NeedsYouView attention lanes (PLA-240)", () => {
  it("a recovering leftover reaches Recovering automatically and not Blocked", () => {
    renderView([
      item("QAP-2", "blocked", { title: "quota parked build", attentionLane: "recovering", assignee: "platform-worker" }),
      item("QAP-10", "blocked", { title: "operator block", attentionLane: "operator" }),
    ])
    expect(screen.getByTestId("needs-group-recovering").textContent).toContain("Recovering automatically")
    expect(screen.getByTestId("needs-group-recovering").textContent).toContain("quota parked build")
    expect(screen.getByTestId("needs-group-blocked").textContent).toContain("operator block")
    expect(screen.getByTestId("needs-group-recovering").textContent).not.toContain("operator block")
  })

  it("an in_review leftover with attentionLane manager reaches Manager attention, not Blocked", () => {
    renderView([
      item("QAP-15", "in_review", { title: "landing leftover", attentionLane: "manager", assignee: "platform-worker" }),
      item("QAP-10", "blocked", { title: "operator block", attentionLane: "operator" }),
    ])
    expect(screen.getByTestId("needs-group-manager").textContent).toContain("Manager attention")
    expect(screen.getByTestId("needs-group-manager").textContent).toContain("landing leftover")
    expect(screen.getByTestId("needs-group-blocked").textContent).toContain("operator block")
    expect(screen.getByTestId("needs-group-manager").textContent).not.toContain("operator block")
  })

  // Only a blocked Todo is blocked: an executing one on Manager attention or
  // recovering on its own says what it is doing instead.
  it("says what each kind of entry is doing, not that every one is blocked", () => {
    renderView([
      item("QAP-21", "executing", { title: "auth failed", attentionLane: "manager", assignee: "platform-worker" }),
      item("QAP-22", "executing", { title: "quota wait", attentionLane: "recovering", assignee: "platform-worker" }),
      item("QAP-23", "blocked", { title: "needs a pick", attentionLane: "operator", assignee: "platform-worker" }),
    ])
    const manager = screen.getByTestId("needs-group-manager").textContent
    expect(manager).toContain("needs a manager")
    expect(manager).not.toContain("is blocked")
    expect(manager).not.toContain("Blocked and waiting")
    expect(screen.getByTestId("needs-group-recovering").textContent).toContain("is recovering")
    expect(screen.getByTestId("needs-group-blocked").textContent).toContain("is blocked")
  })
})
