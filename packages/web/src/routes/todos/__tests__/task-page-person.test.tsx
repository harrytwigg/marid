import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import type { BoardRole } from "@/lib/accounts-api"
import TaskPage from "../task-page/task-page"
import "@/test/preload-menus"

/* The Person row on the Todo page: the operator and a board's collaborators and owners may name or clear the person
 * responsible on any Todo on their board; a viewer sees it as a plain value; the agent row stays the operator's. */

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, principal } }) }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))
vi.mock("@/hooks/use-person-choices", () => ({
  usePersonChoices: () => ({ people: [{ id: "me", displayName: "Mia Member", initials: "MM" }, { id: "kit", displayName: "Kit Colleague", initials: "KC" }], ready: true }),
}))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const setWorkItemPerson = vi.fn()
const updateWorkItem = vi.fn()
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getWorkItemTree: (...a: unknown[]) => getWorkItemTree(...a),
      setWorkItemPerson: (...a: unknown[]) => setWorkItemPerson(...a),
      updateWorkItem: (...a: unknown[]) => updateWorkItem(...a),
      listWorkItemAttachments: async () => ({ attachments: [] }),
      listWorkItemComments: async () => ({ comments: [], total: 0 }),
      listWorkItemSessions: async () => [],
      workItemAttachmentUrl: () => "",
      getDepartments: async () => ({ departments: [{ slug: "platform", prefix: "PLT", createdAt: "", todoCount: 2 }] }),
      getOrg: async () => ({ departments: ["platform"], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: async () => ({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

/** An operator-made Todo with an agent on it: not a member-only tree, so a member edits nothing else on it. */
function agentMade(over: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id: "PLT-1", version: 3, title: "Agent's Todo", body: null, status: "executing", department: "platform", assignee: "mason", priority: 2, rank: null,
    source: "human", sourceRef: null, rounds: 0, budgetUsd: null, createdBy: "operator", parentId: null, rootId: "PLT-1", depth: 0, dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, ...over,
  }
}

function member(role: BoardRole): Principal {
  return { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role }] }
}

function setup(item: WorkItemFullWire) {
  getWorkItem.mockResolvedValue({ workItem: item, spendUsd: principal.kind === "member" ? null : 0, events: [] })
  getWorkItemTree.mockResolvedValue({ tree: { root: { ...item, children: [] } as WorkItemTreeNodeWire, totals: { [item.status]: 1 }, spendUsd: principal.kind === "member" ? null : 0 } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/PLT-1"]}>
        <Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setWorkItemPerson.mockResolvedValue({ workItem: agentMade() })
})

describe("a collaborator or owner", () => {
  it.each(["collaborator", "owner"] as const)("a %s can name the person on an agent's Todo, through the member lane, while the agent row stays read-only", async (role) => {
    principal = member(role)
    setup(agentMade())
    const person = await screen.findByTestId("rail-person")
    expect(person.closest("button")).not.toBeNull()
    expect(screen.getByTestId("rail-assignee").closest("button")).toBeNull()
    expect(screen.getByTestId("rail-assignee").textContent).toContain("mason")
    fireEvent.click(person)
    const picker = await screen.findByTestId("picker-person")
    expect(within(picker).getByTestId("person-option-operator").textContent).toContain("Operator")
    fireEvent.click(within(picker).getByTestId("person-option-me"))
    await waitFor(() => expect(setWorkItemPerson).toHaveBeenCalledWith("PLT-1", "user:me"))
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("can clear the person with the row's × and the chip's ×", async () => {
    principal = member("collaborator")
    setup(agentMade({ humanAssignee: "user:me" }))
    fireEvent.click(await screen.findByTestId("rail-person-clear"))
    await waitFor(() => expect(setWorkItemPerson).toHaveBeenCalledWith("PLT-1", null))
    fireEvent.click(await screen.findByTestId("chip-person-clear"))
    await waitFor(() => expect(setWorkItemPerson).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
  })

  it("says why the gateway refused, and leaves the value as the gateway has it", async () => {
    principal = member("collaborator")
    setWorkItemPerson.mockRejectedValue(new Error("That person does not have access to this board"))
    setup(agentMade())
    fireEvent.click(await screen.findByTestId("rail-person"))
    fireEvent.click(await screen.findByTestId("person-option-kit"))
    await waitFor(() => expect(setWorkItemPerson).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId("rail-person").textContent).toContain("No person"))
  })
})

describe("a viewer", () => {
  it("sees the person as a plain value with nothing to open or clear", async () => {
    principal = member("viewer")
    setup(agentMade({ humanAssignee: "@operator" }))
    const person = await screen.findByTestId("rail-person")
    expect(person.closest("button")).toBeNull()
    expect(person.textContent).toContain("Operator")
    expect(screen.queryByTestId("rail-person-clear")).toBeNull()
    expect(screen.queryByTestId("chip-person-clear")).toBeNull()
  })
})

describe("the operator", () => {
  it("edits both slots through the pen and the assign lane, each on its own", async () => {
    principal = { kind: "operator" }
    updateWorkItem.mockResolvedValue({ workItem: agentMade({ humanAssignee: "user:kit", version: 4 }), replayed: false })
    setup(agentMade())
    fireEvent.click(await screen.findByTestId("rail-person"))
    fireEvent.click(await screen.findByTestId("person-option-kit"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledWith("PLT-1", expect.objectContaining({ patch: { humanAssignee: "user:kit" }, expectedVersion: 3 })))
    expect(setWorkItemPerson).not.toHaveBeenCalled()
    expect(screen.getByTestId("rail-assignee").closest("button")).not.toBeNull()
  })
})
