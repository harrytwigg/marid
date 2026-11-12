import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Where the two assignee slots sit on the Todo page, on every kind of instance: the agent where the one assignee control
 * always was, the person directly after it, and everything that followed moved along. */

const auth = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const listPeople = vi.hoisted(() => vi.fn())
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: { listPeople } }))

const getWorkItem = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (id: string) => Promise.resolve({ tree: { root: { ...item(id), children: [] }, totals: {}, spendUsd: 0 } }),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({ departments: [{ slug: "platform", prefix: "TSK", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 1 }] }),
      getOrg: vi.fn().mockResolvedValue({ departments: ["platform"], employees: [{ name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" }], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function item(id: string, over: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "backlog", department: "platform", assignee: "mason", humanAssignee: "@operator",
    priority: 2, rank: null, source: "human", sourceRef: null, rounds: 0, budgetUsd: null, createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, ...over,
  }
}

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/TSK-12"]}>
        <Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const ids = (root: HTMLElement, wanted: string[]) =>
  [...root.querySelectorAll<HTMLElement>("[data-testid]")].map((node) => node.dataset.testid!).filter((testId) => wanted.includes(testId))

const AUTH_STATES: Array<[string, unknown]> = [
  ["no auth state at all", null],
  ["accounts enabled and none created", { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: false } }],
  ["accounts enabled and some created", { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }],
]

describe.each(AUTH_STATES)("the Todo page with %s", (_name, state) => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.value = state
    listPeople.mockResolvedValue([])
    getWorkItem.mockResolvedValue({ workItem: item("TSK-12"), spendUsd: 0, events: [] })
  })

  it("runs the chip row Status, Agent, Person, Priority", async () => {
    renderTask()
    const row = await screen.findByTestId("chip-person")
    const cluster = row.closest<HTMLElement>('[data-testid="task-chip-cluster"]')!
    expect(ids(cluster, ["chip-status", "chip-assignee", "chip-person", "chip-priority"])).toEqual(["chip-status", "chip-assignee", "chip-person", "chip-priority"])
    expect(within(cluster).getByTestId("chip-assignee").textContent).toContain("Mason")
    await waitFor(() => expect(within(cluster).getByTestId("chip-person").textContent).toContain("You (operator)"))
  })

  it("runs the rail Status, Priority, Agent, Person, then Dispatch, with no Assignee row", async () => {
    renderTask()
    const rail = (await screen.findByTestId("rail-person")).closest<HTMLElement>('[data-testid="task-props-rail"]')!
    expect(ids(rail, ["rail-status", "rail-priority", "rail-assignee", "rail-person", "rail-dispatch", "auto-start-row"]).slice(0, 5))
      .toEqual(["rail-status", "rail-priority", "rail-assignee", "rail-person", "rail-dispatch"])
    expect(within(rail).getByTestId("rail-assignee").getAttribute("aria-label")).toContain("Agent")
    expect(within(rail).getByTestId("rail-person").getAttribute("aria-label")).toContain("Person")
    expect(within(rail).queryByLabelText(/Assignee/)).toBeNull()
  })

  it("keeps its own × on each slot", async () => {
    renderTask()
    expect(await screen.findByTestId("chip-assignee-clear")).toBeTruthy()
    expect(screen.getByTestId("chip-person-clear")).toBeTruthy()
    expect(screen.getByTestId("rail-assignee-clear")).toBeTruthy()
    expect(screen.getByTestId("rail-person-clear")).toBeTruthy()
  })
})
