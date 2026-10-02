import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* PLA-135 — attachment references are first-class run data, so a blocked
 * reason that carries `attachment:<todo>:<id>:<mime>` has to read as the file
 * itself on the surface the operator reads it at, never as the raw token. */

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children, hideMobileTabBar }: { children: React.ReactNode; hideMobileTabBar?: boolean }) => (
    <div data-testid="page-layout" data-hide-mobile-tab-bar={hideMobileTabBar ? "true" : "false"}>{children}</div>
  ),
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemStatus = vi.fn()
const listWorkItemAttachments = vi.fn()
const listWorkItemComments = vi.fn()
const listWorkItemSessions = vi.fn()
const dispatchTodo = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      setWorkItemStatus: (...args: unknown[]) => setWorkItemStatus(...args),
      listWorkItemAttachments: (...args: unknown[]) => listWorkItemAttachments(...args),
      listWorkItemComments: (...args: unknown[]) => listWorkItemComments(...args),
      workItemAttachmentUrl: (id: string, attachmentId: string) =>
        `/api/work-items/${id}/attachments/${attachmentId}`,
      listWorkItemSessions: (...args: unknown[]) => listWorkItemSessions(...args),
      dispatchTodo: (...args: unknown[]) => dispatchTodo(...args),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "PLA", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: (...args: unknown[]) => getOrg(...args),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id,
    version: 3,
    title: `Item ${id}`,
    body: null,
    status: "executing",
    department: "platform",
    assignee: null,
    priority: 2,
    rank: null,
    source: "human",
    sourceRef: null,
    acceptance: null,
    verifyPolicy: null,
    rounds: 1,
    budgetUsd: null,
    createdBy: "operator",
    parentId: null,
    rootId: id,
    depth: 0,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null,
    ...overrides,
  }
}

function detailOf(item: WorkItemFullWire, extra: Partial<WorkItemDetailWire> = {}): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [], ...extra }
}

/** A blocked Todo whose stop reason is `note`. */
function blockedDetail(note: string): WorkItemDetailWire {
  return detailOf(full("PLA-12", { status: "blocked" }), {
    events: [{
      id: "e1", workItemId: "PLA-12", kind: "status_change", fromStatus: "executing",
      toStatus: "blocked", actor: "mason", detail: { note },
      createdAt: "2026-07-23T07:00:00.000Z",
    }],
  })
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask(path = "/todos/PLA-12", state?: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[state ? { pathname: path, state } : path]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
          <Route path="/todos/b/:board" element={<div data-testid="board-probe" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItemTree.mockImplementation((id: string) =>
    Promise.resolve({ tree: { root: treeNode(full(id)), totals: {}, spendUsd: 0 } }),
  )
  listWorkItemAttachments.mockResolvedValue({ attachments: [] })
  listWorkItemComments.mockResolvedValue({ comments: [], total: 0 })
  listWorkItemSessions.mockResolvedValue([])
  dispatchTodo.mockResolvedValue({ workItemId: "PLA-12", sessionId: "dispatcher-session", status: "running", reused: false })
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [],
    hierarchy: { root: null, sorted: [], warnings: [] },
  })
})

describe("the task page blocked banner", () => {
  it("shows an attachment ref in the blocked reason as a thumbnail, not a token", async () => {
    getWorkItem.mockResolvedValue(blockedDetail("Ship this? attachment:PLA-12:wia_ab12cd34ef56:image/png"))
    renderTask()

    const banner = await screen.findByTestId("task-banner-blocked")
    expect(banner.textContent).toContain("Ship this?")
    expect(banner.textContent).not.toContain("wia_ab12cd34ef56:image/png")
    expect(within(banner).getByTestId("attachment-ref-thumb-wia_ab12cd34ef56")).toBeTruthy()
  })

  it("shows a non-image ref in the blocked reason as a named file row", async () => {
    getWorkItem.mockResolvedValue(blockedDetail("Sign off? attachment:PLA-12:wia_00112233aabb:application/pdf"))
    renderTask()

    const banner = await screen.findByTestId("task-banner-blocked")
    expect(within(banner).getByTestId("attachment-ref-file-wia_00112233aabb").textContent).toContain("PDF")
    expect(within(banner).queryByTestId("attachment-ref-thumb-wia_00112233aabb")).toBeNull()
  })
})
