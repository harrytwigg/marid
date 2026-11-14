import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire } from "@/lib/api"
import { MovedOffBoard } from "../board/moved-off-board"
import { useQueryInvalidation } from "@/hooks/use-query-invalidation"
import { decodeGatewayEvent, type GatewayEventListener } from "@hundredfold/gateway-events"

// The live feed a board member holds: the gateway tells them, in one `removed` frame, that a Todo left what they can read.
// `lib/ws.ts` decodes every frame before a listener sees it and drops what does not decode, so the test sends the raw frame
// through the same decoder.
let listener: GatewayEventListener | undefined
vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    connectionSeq: 1,
    subscribe: (next: GatewayEventListener) => {
      listener = next
      return () => { listener = undefined }
    },
  }),
}))
vi.mock("@/hooks/use-principal", () => ({
  useMember: () => ({ user: { id: "u1", email: "m@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "collaborator" }] }),
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const listMovedOffBoard = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, listMovedOffBoard: (...args: unknown[]) => listMovedOffBoard(...args) } }
})

function item(id: string): WorkItemCompactWire {
  return {
    id, version: 2, title: `Roadmap review ${id}`, status: "backlog", department: "design", assignee: "design-lead", priority: 2, rank: null,
    source: "connector", createdBy: "user:u1", parentId: null, rootId: id, depth: 0, dueAt: null, movedToAnotherBoard: true,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null,
  } as unknown as WorkItemCompactWire
}

function Harness() {
  useQueryInvalidation()
  return <MovedOffBoard board="platform" byName={new Map()} onOpen={() => {}} />
}

describe("a member's open board follows a removed frame", () => {
  beforeEach(() => { listMovedOffBoard.mockReset() })
  afterEach(() => { vi.useRealTimers() })

  it("drops a moved-off card when the gateway says that Todo was removed", async () => {
    let open: WorkItemCompactWire[] = [item("PLA-7")]
    listMovedOffBoard.mockImplementation(async () => ({ workItems: open, total: open.length, nextOffset: null }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
    expect(await screen.findByText("Roadmap review PLA-7")).toBeTruthy()
    const before = listMovedOffBoard.mock.calls.length

    // The operator closes it: the list the gateway serves no longer holds it, and the frame names only its id.
    open = []
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const frame = decodeGatewayEvent({ event: "company:changed", payload: { entity: "todo", action: "removed", id: "PLA-7" } })
    act(() => { if (frame) listener?.(frame) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500) })

    await waitFor(() => expect(screen.queryByText("Roadmap review PLA-7")).toBeNull())
    expect(screen.queryByTestId("moved-off-board")).toBeNull()
    expect(listMovedOffBoard.mock.calls.length).toBeGreaterThan(before)
  })
})
