import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCommentWire, WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import { ActivitySection } from "../task-page/activity"

/* GET /api/work-items/:id embeds the LAST comments of the thread, so
 * the activity feed asks the comments route only for the head in front of them
 * instead of re-fetching a page it was already handed. A thread short enough to
 * fit inside that tail asks for nothing at all, and a request that never fires
 * can never refresh: the feed has to read the tail the detail payload carries,
 * not a copy of it frozen at first paint. */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const listWorkItemComments = vi.fn()
const listWorkItemAttachments = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      workItemAttachmentUrl: (id: string, aid: string) => `/api/work-items/${id}/attachments/${aid}`,
    },
  }
})

function comment(id: string, body: string, at: string, deletedAt: string | null = null): WorkItemCommentWire {
  return {
    id, workItemId: "TSK-12", parentCommentId: null, authorKind: "employee", author: "mason",
    body, createdAt: at, editedAt: null, deletedAt,
  }
}

/** The feed reads three things off a detail payload: the id, the events, the tail. */
function detailOf(comments: WorkItemCommentWire[], total: number): WorkItemDetailWire {
  return { workItem: { id: "TSK-12" } as WorkItemFullWire, spendUsd: 0, events: [], comments: { comments, total } }
}

/** 13 comments an hour apart, oldest first — wic_01 … wic_13. */
const thread = Array.from({ length: 13 }, (_, i) =>
  comment(`wic_${String(i + 1).padStart(2, "0")}`, `Note ${i + 1}`, `2026-07-22T${String(i + 8).padStart(2, "0")}:00:00.000Z`),
)

function renderActivity(detail: WorkItemDetailWire) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const tree = (shown: WorkItemDetailWire) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ActivitySection detail={shown} byName={new Map()} mobile={false} announce={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>
  )
  const view = render(tree(detail))
  return { ...view, show: (next: WorkItemDetailWire) => view.rerender(tree(next)) }
}

function renderedCommentIds() {
  return [...screen.getByTestId("task-activity").querySelectorAll('[data-testid^="activity-comment-"]')].map((node) =>
    node.getAttribute("data-testid"),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
})

describe("the embedded comment tail is not paid for twice", () => {
  it("asks only for the head the tail is missing, then shows all 13 comments once, newest first", async () => {
    listWorkItemComments.mockResolvedValue({ comments: thread.slice(0, 3), total: 13 })
    renderActivity(detailOf(thread.slice(3), 13))

    await waitFor(() => expect(listWorkItemComments).toHaveBeenCalledWith("TSK-12", { limit: 3, offset: 0 }))
    expect(listWorkItemComments).toHaveBeenCalledTimes(1)

    await screen.findByTestId("activity-comment-wic_01")
    expect(renderedCommentIds()).toEqual([...thread].reverse().map((c) => `activity-comment-${c.id}`))
  })

  it("asks for nothing when the tail is the whole thread, and paints it populated", () => {
    renderActivity(detailOf(thread.slice(0, 3), 3))

    // No await: the tail renders straight off the detail payload, so there is
    // no empty frame to flash through.
    expect(renderedCommentIds()).toEqual(["wic_03", "wic_02", "wic_01"].map((id) => `activity-comment-${id}`))
    expect(listWorkItemComments).not.toHaveBeenCalled()
  })

  it("shows the tombstone once a deleted comment reaches a tail it never re-fetches", async () => {
    const view = renderActivity(detailOf(thread.slice(0, 3), 3))
    expect(screen.getByTestId("activity-comment-wic_02").textContent).toContain("Note 2")

    const tombstoned = comment("wic_02", "Note 2", thread[1].createdAt, "2026-07-22T20:00:00.000Z")
    view.show(detailOf([thread[0], tombstoned, thread[2]], 3))

    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_02").textContent).toContain("[deleted]"))
    expect(listWorkItemComments).not.toHaveBeenCalled()
  })
})
