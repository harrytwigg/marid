import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import { OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { comment } from "./fixtures/task-wire"

/* The operator's own comments carry their chosen icon. Employee comments keep
 * resolving through EmployeeAvatar, so only the operator branch is pinned here. */

const settings: { operatorEmoji: string | null; employeeOverrides: Record<string, never> } = {
  operatorEmoji: null,
  employeeOverrides: {},
}

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings }) }))
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

const item = {
  id: "PLA-12", version: 1, title: "Item", body: null, status: "executing", department: null,
  assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
  verifyPolicy: null, rounds: 0, budgetUsd: null,
  createdBy: "operator", parentId: null, rootId: "PLA-12", depth: 0,
  dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-20T08:00:00.000Z",
  closedAt: null,
} as WorkItemFullWire

function renderOperatorComment(operatorEmoji: string | null) {
  settings.operatorEmoji = operatorEmoji
  const detail: WorkItemDetailWire = {
    workItem: item,
    spendUsd: 0,
    events: [],
    comments: {
      comments: [comment("wic_000000000001", "mine", "2026-07-20T09:00:00.000Z", { authorKind: "operator", author: "operator" })],
      total: 1,
    },
  } as unknown as WorkItemDetailWire
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ActivitySection detail={detail} byName={new Map()} mobile={false} announce={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.getByTestId("activity-comment-wic_000000000001")
}

describe("operator comment avatar", () => {
  it("shows the operator's chosen emoji", () => {
    expect(renderOperatorComment("🦊").textContent).toContain("🦊")
  })

  it("keeps the shipped default when the operator has chosen none", () => {
    const block = renderOperatorComment(null)
    expect(block.textContent).toContain(OPERATOR_DEFAULT_EMOJI)
  })
})
