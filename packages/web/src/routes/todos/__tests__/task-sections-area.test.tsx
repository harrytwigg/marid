import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemRunWire } from "@/lib/api"
import { AREAS } from "@/contrib/types"
import { contributeProbes, describeHostedArea } from "@/contrib/__tests__/hosted-area"
import TaskPage from "../task-page/task-page"

/* PLA-107 — the task page hosts `todo.detail.sections`. Contributed sections
 * close the document, after the app's own sections and before the properties
 * rail and Activity. */

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const getOrg = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      getOrg: (...args: unknown[]) => getOrg(...args),
      setWorkItemStatus: vi.fn(),
      dispatchTodo: vi.fn(),
      workItemAttachmentUrl: (id: string, attachmentId: string) =>
        `/api/work-items/${id}/attachments/${attachmentId}`,
      listWorkItemAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
      listWorkItemComments: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
      getDepartments: vi.fn().mockResolvedValue({ departments: [] }),
    },
  }
})

const ITEM = {
  id: "PLA-12",
  version: 3,
  title: "A Todo",
  body: null,
  status: "executing",
  department: "platform",
  assignee: null,
  priority: 2,
  rank: null,
  source: "human",
  sourceRef: null,

  rounds: 1,
  budgetUsd: null,
  createdBy: "operator",
  parentId: null,
  rootId: "PLA-12",
  depth: 0,
  dueAt: null,
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  closedAt: null,
} as unknown as WorkItemFullWire

/** The contributed area is anchored after Runs, and a Todo nobody has attempted
 *  renders no Runs section to sit after — so the fixture carries one attempt. */
const RUN = {
  id: "wir_000000000001",
  workItemId: "PLA-12",
  sessionId: "session-1",
  startedAt: "2026-07-22T08:00:00.000Z",
  endedAt: "2026-07-22T08:40:00.000Z",
  outcome: "completed",
  summary: null,
  handoff: {},
  error: null,
} as unknown as WorkItemRunWire

beforeEach(() => {
  vi.clearAllMocks()
  getWorkItem.mockResolvedValue({ workItem: ITEM, spendUsd: 0, events: [], runs: [RUN] })
  getWorkItemTree.mockResolvedValue({ tree: { root: { ...ITEM, children: [] }, totals: {}, spendUsd: 0 } })
  getOrg.mockResolvedValue({
    departments: ["platform"],
    employees: [],
    hierarchy: { root: null, sorted: [], warnings: [] },
  })
})

/** The page waits on its Todo query, so every assertion runs after the document
 *  itself has arrived — a contribution asserted against the skeleton would pass
 *  without the page ever having rendered. */
async function renderTaskPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLA-12"]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByTestId("task-body")
}

describeHostedArea("the task page", {
  area: AREAS.todoDetailSections,
  variant: "pane",
  renderHost: renderTaskPage,
  findHostContent: async () => screen.findByTestId("task-subtasks"),
})

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

it("puts a contributed section in the page body, after Sub-tasks and before Activity", async () => {
  dispose = contributeProbes(AREAS.todoDetailSections, [{ id: "widget" }])

  await renderTaskPage()

  const contributed = screen.getByTestId("probe-widget")
  const subtasks = await screen.findByTestId("task-subtasks")
  const activity = await screen.findByTestId("task-activity")

  expect(contributed.closest("main")).toBe(subtasks.closest("main"))
  expect(subtasks.compareDocumentPosition(contributed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(contributed.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  // Activity closes the document: nothing renders after it inside <main>.
  expect(activity.parentElement?.tagName).toBe("MAIN")
  expect(activity.nextElementSibling).toBeNull()
})
