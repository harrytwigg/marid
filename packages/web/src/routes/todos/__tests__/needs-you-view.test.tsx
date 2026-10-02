import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { WorkItemCompactWire, WorkItemOpenDetailWire, WorkItemStatusWire } from "@/lib/api"
import { createBrowserGatewayTransport, installGatewayTransport } from "@/lib/gateway-transport"
import { NeedsYouView, attentionIdLine } from "../needs-you-view"

/* Todos v2 slice 6 stage C — the Attention inbox restyled to states.html §1:
 * fixed kicker order, oldest-first within a group, mono ID line, the voice's
 * rail quote (reason notes from detail enrichment), and blocked items route
 * through legalTargets() menus. */

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { employeeOverrides: {} } }),
}))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const getWorkItems = vi.fn()
const getWorkItemTrees = vi.fn()
const setWorkItemStatus = vi.fn()
const ACTIVE_ORIGIN = "https://qa-a.example:7779"

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

/** Detail enrichment that gives every card the same blocked-reason note. */
function stopNote(note: string) {
  getWorkItems.mockImplementation((ids: string[]) =>
    Promise.resolve({
      workItems: ids.map((id) => ({
        workItem: { id, version: 3, rounds: 0, source: "cron" },
        events: [
          {
            id: "e1", workItemId: id, kind: "status_change", fromStatus: "executing",
            toStatus: "blocked", actor: "mason", detail: { note },
            createdAt: "2026-07-04T09:00:00.000Z",
          },
        ],
      })),
    }),
  )
}

function renderView(items: WorkItemCompactWire[]) {
  const onOpen = vi.fn<(id: string) => void>()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NeedsYouView items={items} byName={new Map()} onOpen={onOpen} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpen, container: view.container }
}

beforeEach(() => {
  restoreTransport = installGatewayTransport(createBrowserGatewayTransport({
    origin: ACTIVE_ORIGIN,
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

describe("NeedsYouView", () => {
  it("shows the All quiet. zero state when nothing needs the caller (states mock §6)", () => {
    renderView([])
    expect(screen.getByTestId("needs-you-empty")).toBeTruthy()
    expect(screen.getByText("All quiet.")).toBeTruthy()
  })

  it("groups by kind in fixed kicker order — Recovering, Manager, Blocked — oldest first within a group", () => {
    renderView([
      item("wi_private_blocked_new", "blocked", { title: "Newer block", updatedAt: "2026-07-05T11:00:00.000Z" }),
      item("wi_private_blocked_old", "blocked", { title: "Older block", updatedAt: "2026-07-01T09:00:00.000Z" }),
      item("wi_private_manager", "in_review", { title: "Manager item", attentionLane: "manager" }),
      item("wi_private_recovering", "blocked", { title: "Recovering item", attentionLane: "recovering" }),
    ])
    const groups = screen.getAllByTestId(/needs-group-/).map((el) => el.getAttribute("data-testid"))
    expect(groups).toEqual(["needs-group-recovering", "needs-group-manager", "needs-group-blocked"])
    // Oldest-first inside Blocked: the longest-waiting ask wins.
    const blocked = screen.getByTestId("needs-group-blocked")
    const titles = Array.from(blocked.querySelectorAll('[data-testid="needs-item"]')).map((el) => el.textContent ?? "")
    expect(titles[0]).toContain("Older block")
    expect(titles[1]).toContain("Newer block")
  })

  it("offers no approve or reject controls on any card", () => {
    renderView([item("wi_private_blocked", "blocked"), item("wi_private_review", "in_review", { attentionLane: "manager" })])
    expect(screen.queryByTestId("needs-approve")).toBeNull()
    expect(screen.queryByTestId("needs-reject")).toBeNull()
    expect(screen.queryByTestId("needs-group-approval")).toBeNull()
  })

  it("shows an attachment ref in the card's quote as a thumbnail, not a token", async () => {
    stopNote("Ship this? attachment:PLA-12:wia_ab12cd34ef56:image/png")
    renderView([item("PLA-12", "blocked")])
    await screen.findByTestId("attachment-ref-thumb-wia_ab12cd34ef56")
    const card = screen.getByTestId("needs-item")
    expect(card.textContent).toContain("Ship this?")
    expect(card.textContent).not.toContain("wia_ab12cd34ef56:image/png")
    const thumb = screen.getByTestId("attachment-ref-thumb-wia_ab12cd34ef56")
    expect(thumb.querySelector("img")?.getAttribute("src"))
      .toBe(`${ACTIVE_ORIGIN}/api/work-items/PLA-12/attachments/wia_ab12cd34ef56?thumb=1`)
  })

  it("shows a ref whose bytes are gone as a named file row rather than a broken image", async () => {
    stopNote("Still there? attachment:PLA-12:wia_ab12cd34ef56:image/png")
    renderView([item("PLA-12", "blocked")])
    fireEvent.error((await screen.findByTestId("attachment-ref-thumb-wia_ab12cd34ef56")).querySelector("img")!)

    expect(screen.queryByTestId("attachment-ref-thumb-wia_ab12cd34ef56")).toBeNull()
    expect(screen.getByTestId("attachment-ref-file-wia_ab12cd34ef56")).toBeTruthy()
  })

  it("Unblock… lists the legal exits from legalTargets() and commits the chosen transition", async () => {
    setWorkItemStatus.mockResolvedValue({ workItem: {}, escalated: false })
    renderView([item("wi_private_blocked", "blocked", { title: "Blocked item" })])
    const trigger = screen.getByTestId("needs-unblock")
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    // The legality module's edges from blocked — backlog leads the manual
    // exits, and executing resumes the work in place.
    const backlog = await screen.findByTestId("needs-unblock-backlog")
    expect(screen.getByTestId("needs-unblock-in_review")).toBeTruthy()
    expect(screen.getByTestId("needs-unblock-executing")).toBeTruthy()
    fireEvent.click(backlog)
    await waitFor(() => expect(setWorkItemStatus).toHaveBeenCalledWith("wi_private_blocked", "backlog", undefined))
  })

  it("a blocked item whose stop was an escalation event reads as escalated, without a round count", () => {
    const detail = {
      workItem: { id: "wi_private_blocked", rounds: 2 },
      events: [{ id: "e1", workItemId: "wi_private_blocked", kind: "escalated", fromStatus: "in_review", toStatus: "blocked", createdAt: "2026-07-05T11:00:00.000Z", detail: { reason: "max-rounds-exhausted" } }],
    } as unknown as WorkItemOpenDetailWire
    const line = attentionIdLine(item("wi_private_blocked", "blocked"), "blocked", detail)
    expect(line).toContain("escalated")
    expect(line).not.toContain("round")
  })

  it("reads a migrated escalation through the migration move, from when it escalated", () => {
    const detail = {
      workItem: { id: "wi_private_blocked", rounds: 1 },
      events: [
        { id: "e1", workItemId: "wi_private_blocked", kind: "status_change", fromStatus: "executing", toStatus: "escalated", createdAt: "2026-07-05T11:00:00.000Z", detail: { note: "which vendor?" } },
        { id: "e2", workItemId: "wi_private_blocked", kind: "status_change", fromStatus: "escalated", toStatus: "blocked", actor: "migration", createdAt: new Date().toISOString(), detail: { reason: "retired-status", declared: true } },
      ],
    } as unknown as WorkItemOpenDetailWire
    const line = attentionIdLine(item("wi_private_blocked", "blocked"), "blocked", detail)
    expect(line).toMatch(/^escalated \d+ jul|^escalated jul \d+/i)
    expect(line).not.toContain("round")
  })

  it("the voice quotes the blocked reason note from detail enrichment", async () => {
    getWorkItems.mockImplementation((ids: string[]) =>
      Promise.resolve({
        workItems: ids.map((id) => ({
          workItem: { id, version: 3, rounds: 0, source: "cron" },
          events: [
            {
              id: "e1", workItemId: id, kind: "status_change", fromStatus: "executing",
              toStatus: "blocked", actor: "mason", detail: { note: "Waiting on vendor sandbox keys" },
              createdAt: "2026-07-04T09:00:00.000Z",
            },
          ],
        })),
      }),
    )
    renderView([item("wi_private_blocked", "blocked")])
    await waitFor(() => expect(screen.getByText("Waiting on vendor sandbox keys")).toBeTruthy())
  })

  // QA regression 2026-07-10: the gateway's sessionRef is { sessionId, ref? } —
  // an unassigned session-sourced item must render (it used to crash the
  // whole lens reading `.id` off the real shape).
  it("renders an unassigned session-sourced item from the real sessionRef shape", () => {
    renderView([
      item("sess", "blocked", {
        source: "session",
        sourceRef: "session:sess_1234567890abcdef:launch-note",
        sessionRef: { sessionId: "sess_1234567890abcdef", ref: "launch-note" },
      }),
      item("bare", "blocked", {
        source: "session",
        sourceRef: "session:sess_zz999",
        sessionRef: { sessionId: "sess_zz999" },
      }),
    ])
    expect(screen.getAllByTestId("needs-item")).toHaveLength(2)
    expect(screen.getByText("Session · launch-note")).toBeTruthy()
    // No ref suffix → the shortened session id, never a crash.
    expect(screen.getByText("Session · sess_zz999")).toBeTruthy()
  })

  it("never renders an opaque work-item id from identity or reference fields (the ID line renders public ids only)", () => {
    const { container } = renderView([
      item("wi_private_card", "blocked", {
        sourceRef: "workflow:wi_private_source:run",
      }),
    ])
    expect(container.innerHTML).not.toMatch(/wi_[a-z0-9_-]+/i)
  })

  it("the ID line renders the public id + status phrase (PLA-26 · In review)", () => {
    renderView([item("PLA-26", "in_review", { attentionLane: "manager" })])
    expect(screen.getByText("PLA-26 · In review")).toBeTruthy()
  })
})
