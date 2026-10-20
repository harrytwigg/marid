import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemRunWire } from "@/lib/api"
import { comment, event, run } from "./fixtures/task-wire"

/* The run ledger's read surface, now inside the one
 * Activity stream: an attempt reads as a start line and, once it settles, an
 * end line carrying its outcome and the handoff a reviewer reads. An OPEN
 * attempt reads as in-flight instead of borrowing an outcome it never
 * reported, a Todo nobody has attempted shows no run lines and no empty state,
 * and the lines sort chronologically among the comments. */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { operatorEmoji: null, employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItemComments: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
      listWorkItemAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
      addWorkItemComment: vi.fn(),
      editWorkItemComment: vi.fn(),
      deleteWorkItemComment: vi.fn(),
      uploadWorkItemAttachment: vi.fn(),
      workItemAttachmentUrl: (id: string, aid: string) => `/api/work-items/${id}/attachments/${aid}`,
    },
  }
})

import { ActivitySection } from "../task-page/activity"

const SETTLED_LABELS = ["Completed", "Blocked", "Crashed", "Timed out", "Abandoned", "Rate limited"]

const item = { id: "TSK-12", createdAt: "2026-07-20T08:00:00.000Z" } as WorkItemFullWire

function renderActivity(runs: WorkItemRunWire[], extra: Partial<WorkItemDetailWire> = {}) {
  const detail = { workItem: item, spendUsd: 0, events: [], runs, ...extra } as unknown as WorkItemDetailWire
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ActivitySection detail={detail} byName={new Map()} mobile={false} announce={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.getByTestId("task-activity")
}

describe("run attempts in the activity stream", () => {
  it("gives a settled attempt a start line and an end line carrying its outcome and handoff", () => {
    const activity = renderActivity([
      run("wir_000000000001", {
        outcome: "crashed",
        summary: "Fell over installing the toolchain",
        error: "The session running this attempt is gone.",
        handoff: { retryNotes: "Pin the toolchain before installing." },
      }),
      run("wir_000000000002", {
        startedAt: "2026-07-22T09:00:00.000Z",
        endedAt: "2026-07-22T09:40:00.000Z",
        summary: "Guest checkout shipped",
        handoff: {
          changedFiles: ["src/checkout/session.ts", "src/checkout/session.test.ts"],
          verification: "Unit suite green",
          residualRisk: "The refund path is still untested.",
        },
      }),
    ])

    expect(screen.getByTestId("run-start-wir_000000000001")).toBeTruthy()
    const crashed = screen.getByTestId("run-end-wir_000000000001")
    expect(crashed.textContent).toContain("Crashed")
    expect(crashed.textContent).toContain("Fell over installing the toolchain")
    const crashedHandoff = screen.getByTestId("run-handoff-wir_000000000001")
    expect(crashedHandoff.textContent).toContain("Pin the toolchain before installing.")
    expect(crashedHandoff.textContent).toContain("The session running this attempt is gone.")

    expect(screen.getByTestId("run-end-wir_000000000002").textContent).toContain("Completed")
    const handoff = screen.getByTestId("run-handoff-wir_000000000002")
    expect(handoff.textContent).toContain("src/checkout/session.ts")
    expect(handoff.textContent).toContain("src/checkout/session.test.ts")
    expect(handoff.textContent).toContain("Unit suite green")
    expect(handoff.textContent).toContain("The refund path is still untested.")
    // Nothing was reported for retry notes, so the line stays silent about it.
    expect(handoff.textContent).not.toContain("Retry notes")

    // Newest first, so each attempt's end line precedes the start it belongs to.
    const lines = [...activity.querySelectorAll('[data-testid^="run-start-"], [data-testid^="run-end-"]')]
    expect(lines.map((line) => line.getAttribute("data-testid"))).toEqual([
      "run-end-wir_000000000002",
      "run-start-wir_000000000002",
      "run-end-wir_000000000001",
      "run-start-wir_000000000001",
    ])
  })

  it("titles the stream Activity, once, and keeps no Runs heading of its own", () => {
    const activity = renderActivity([run("wir_1")])

    const headings = [...activity.querySelectorAll("div")].filter((node) => node.textContent === "Activity")
    expect(headings).toHaveLength(1)
    expect(activity.firstElementChild).toBe(headings[0])
    expect(activity.textContent).not.toContain("Runs")
  })

  it("reads an open attempt as one in-flight line and never gives it a settled outcome", () => {
    const activity = renderActivity([run("wir_00000000open", { endedAt: null, outcome: null })])

    const line = screen.getByTestId("run-start-wir_00000000open")
    expect(line.textContent).toContain("Running")
    for (const label of SETTLED_LABELS) expect(line.textContent).not.toContain(label)
    expect(activity.querySelectorAll('[data-testid^="run-end-"]').length).toBe(0)
    // Nothing was handed off yet either — an open attempt has reported nothing.
    expect(screen.queryByTestId("run-handoff-wir_00000000open")).toBeNull()
  })

  it("shows the stream with no run lines, and no empty state, when nothing has been attempted", () => {
    const activity = renderActivity([], { events: [event("e1", "created", "2026-07-20T08:00:00.000Z")] })

    expect(activity.querySelectorAll('[data-testid^="run-start-"], [data-testid^="run-end-"]').length).toBe(0)
    expect(activity.textContent).toContain("created this todo")
    expect(activity.textContent).not.toContain("No runs")
  })

  it("brackets a comment made mid-attempt between that attempt's two lines", async () => {
    renderActivity([run("wir_1", { startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:40:00.000Z" })], {
      comments: { comments: [comment("wic_mid", "Halfway", "2026-07-22T08:20:00.000Z")], total: 1 },
    })

    const midComment = await screen.findByTestId("activity-comment-wic_mid")
    const start = screen.getByTestId("run-start-wir_1")
    const end = screen.getByTestId("run-end-wir_1")
    // Newest first: the end line, then the comment, then the start line.
    expect(end.compareDocumentPosition(midComment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(midComment.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
