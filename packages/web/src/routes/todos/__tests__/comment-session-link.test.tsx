import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import type { SessionDirectoryEntryWire } from "@/lib/session-tree-api"
import { comment } from "./fixtures/task-wire"

/* A comment written from a session carries that session's id; its header shows
 * a small "session" link that opens the session. A comment with no recorded
 * session shows no link at all. */

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
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
import { SessionDirectoryProvider } from "../task-page/session-ref"

const item = {
  id: "PLA-12", version: 1, title: "Item", body: null, status: "executing", department: null,
  assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
  verifyPolicy: null, rounds: 0, budgetUsd: null,
  createdBy: "operator", parentId: null, rootId: "PLA-12", depth: 0,
  dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-20T08:00:00.000Z",
  closedAt: null,
} as WorkItemFullWire

function Where() {
  const location = useLocation()
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>
}

function renderThread(
  comments: ReturnType<typeof comment>[],
  directory?: Record<string, SessionDirectoryEntryWire>,
) {
  const detail = {
    workItem: item,
    spendUsd: 0,
    events: [],
    comments: { comments, total: comments.length },
  } as unknown as WorkItemDetailWire
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLA-12"]}>
        <Routes>
          <Route
            path="*"
            element={
              <SessionDirectoryProvider directory={directory}>
                <ActivitySection detail={detail} byName={new Map()} mobile={false} announce={vi.fn()} />
                <Where />
              </SessionDirectoryProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const AT = "2026-07-20T09:00:00.000Z"

describe("comment session link", () => {
  it("shows a session link in the header of a comment that has a sessionId", () => {
    renderThread([comment("wic_000000000001", "handing this over", AT, { author: "mason", sessionId: "sess-abc-123" })])
    const header = screen.getByTestId("activity-comment-wic_000000000001")
    const link = screen.getByTestId("session-ref-sess-abc-123")
    expect(header.contains(link)).toBe(true)
    expect(link.textContent).toBe("session")
    expect(link.getAttribute("data-session-id")).toBe("sess-abc-123")
  })

  it("opens the session when the link is clicked", () => {
    renderThread([comment("wic_000000000001", "handing this over", AT, { author: "mason", sessionId: "sess-abc-123" })])
    fireEvent.click(screen.getByTestId("session-ref-sess-abc-123"))
    expect(screen.getByTestId("where").textContent).toBe("/?session=sess-abc-123")
  })

  it("shows no session link on a comment without a sessionId", () => {
    renderThread([comment("wic_000000000001", "written in the browser", AT, { authorKind: "operator", author: "operator" })])
    expect(screen.getByTestId("activity-comment-wic_000000000001")).toBeTruthy()
    expect(document.querySelector('[data-testid^="session-ref-"]')).toBeNull()
    expect(screen.queryByText("session")).toBeNull()
  })

  it("links only the comments that carry a session when a thread mixes both", () => {
    renderThread([
      comment("wic_000000000001", "from a session", AT, { author: "mason", sessionId: "sess-1" }),
      comment("wic_000000000002", "from the browser", "2026-07-20T09:05:00.000Z", { authorKind: "operator", author: "operator" }),
    ])
    expect(screen.getAllByText("session")).toHaveLength(1)
    expect(screen.getByTestId("activity-comment-wic_000000000001").querySelector('[data-testid="session-ref-sess-1"]')).toBeTruthy()
    expect(screen.getByTestId("activity-comment-wic_000000000002").querySelector('[data-testid^="session-ref-"]')).toBeNull()
  })

  it("shows a repliedToId-carrying comment like any other, without a second link", () => {
    renderThread([
      comment("wic_000000000001", "the question", AT, { author: "mason", sessionId: "sess-1" }),
      comment("wic_000000000002", "the answer", "2026-07-20T09:05:00.000Z", {
        author: "alex", parentCommentId: "wic_000000000001", repliedToId: "wic_000000000001",
      }),
    ])
    expect(screen.getAllByText("session")).toHaveLength(1)
    expect(screen.getByTestId("activity-comment-wic_000000000002").textContent).toContain("the answer")
  })

  it("does not link a session that no longer exists", () => {
    renderThread(
      [comment("wic_000000000001", "gone", AT, { author: "mason", sessionId: "sess-gone" })],
      { "sess-gone": { id: "sess-gone", missing: true } as SessionDirectoryEntryWire },
    )
    expect(screen.getByTestId("session-ref-missing-sess-gone").tagName).not.toBe("BUTTON")
    expect(screen.queryByTestId("session-ref-sess-gone")).toBeNull()
  })
})
