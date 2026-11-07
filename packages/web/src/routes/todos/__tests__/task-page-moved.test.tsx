import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import type { BoardRole } from "@/lib/accounts-api"
import TaskPage from "../task-page/task-page"
import "@/test/preload-menus"

type Principal = { kind: "operator" } | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: { department: string; role: BoardRole }[] }
let principal: Principal = { kind: "operator" }
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => ({ principal, authState: { accountsEnabled: true, hasAccounts: true, principal } }) }))
vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const assignWorkItem = vi.fn()
const getBoardRoster = vi.fn()
const listPeople = vi.fn()
const employees = [
  { name: "alice", displayName: "Alice", department: "platform", rank: "employee", engine: "claude", model: "sonnet", persona: "" },
  { name: "bob", displayName: "Bob", department: "design", rank: "employee", engine: "claude", model: "sonnet", persona: "" },
]
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...a: unknown[]) => getWorkItem(...a),
      getWorkItemTree: (...a: unknown[]) => getWorkItemTree(...a),
      assignWorkItem: (...a: unknown[]) => assignWorkItem(...a),
      listWorkItemAttachments: async () => ({ attachments: [] }),
      listWorkItemComments: async () => ({ comments: [], total: 0 }),
      listWorkItemSessions: async () => [],
      workItemAttachmentUrl: () => "",
      getDepartments: async () => ({
        departments: [
          { slug: "platform", prefix: "PLT", createdAt: "", todoCount: 2 },
          { slug: "design", prefix: "DES", createdAt: "", todoCount: 1 },
        ],
      }),
      getOrg: async () => ({ departments: ["platform", "design"], employees, hierarchy: { root: null, sorted: [], warnings: [] } }),
      listWorkItems: async () => ({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})
vi.mock("@/lib/accounts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts-api")>()
  return {
    ...actual,
    accountsApi: {
      ...actual.accountsApi,
      listPeople: (...a: unknown[]) => listPeople(...a),
      getMemberPeople: async () => ({ people: [{ id: "me", displayName: "Mia Member", initials: "MM" }], employees: [] }),
      getBoardRoster: (...a: unknown[]) => getBoardRoster(...a),
      listMemberBoards: async () => (principal.kind === "member" ? principal.boards.map((board) => ({ ...board, prefix: "X" })) : []),
    },
  }
})

const MOVED = "Moved to another board"
const HINT = "Visible to the members of this board"
const WARNING = "Mia Member created this. After this change they can still read it and comment, but not edit it."
const WARNING_READ = "Mia Member created this. After this change they can still read it, but not comment or edit it."
const WARNING_NONE = "Mia Member created this. After this change they will lose access to it."
const roster = (role?: "viewer" | "collaborator" | "owner") => ({
  members: role ? [{ userId: "me", displayName: "Mia Member", email: "m@example.test", initials: "MM", role }] : [],
  invites: [],
})

function full(id: string, o: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "backlog", department: "platform", assignee: null, priority: 2, rank: null,
    source: "connector", sourceRef: null, rounds: 0, budgetUsd: null, createdBy: "user:me", parentId: null, rootId: id, depth: 0, dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z", closedAt: null, ...o,
  }
}
const node = (item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire => ({ ...item, children })

function member(...boards: { department: string; role: BoardRole }[]): Principal {
  return { kind: "member", user: { id: "me", email: "me@example.test", displayName: "Mia Member" }, boards }
}

function setup(root: WorkItemFullWire, children: WorkItemFullWire[] = [], filedOn: string | null = "platform") {
  const isMember = principal.kind === "member"
  // The operator's read carries the board a member filed the root on, which is where their access is anchored.
  const events = filedOn === null ? [] : [{
    id: "e1", workItemId: root.id, kind: "created", fromStatus: null, toStatus: "backlog", actor: "connector",
    detail: { createdOnBoard: filedOn }, createdAt: "2026-07-20T08:00:00.000Z",
  }]
  getWorkItem.mockResolvedValue({ workItem: root, spendUsd: isMember ? null : 0, events })
  const totals: Record<string, number> = {}
  for (const item of [root, ...children]) totals[item.status] = (totals[item.status] ?? 0) + 1
  getWorkItemTree.mockResolvedValue({ tree: { root: node(root, children.map((c) => node(c))), totals, spendUsd: isMember ? null : 0 } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/todos/${root.id}`]}>
        <Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  assignWorkItem.mockResolvedValue({ workItem: full("PLT-1") })
  getBoardRoster.mockResolvedValue(roster("collaborator"))
  listPeople.mockResolvedValue([{ id: "me", email: "mia@example.test", displayName: "Mia Member", initials: "MM", status: "active" }])
})

describe("a member's Todo that left their boards", () => {
  const moved = (o: Partial<WorkItemFullWire> = {}) => full("PLT-1", { department: null, movedToAnotherBoard: true, memberCanComment: true, ...o })

  it("says it moved, names no board, and offers comments but no edit, close or sub-task", async () => {
    principal = member({ department: "design", role: "collaborator" })
    setup(moved(), [full("PLT-2", { parentId: "PLT-1", department: "design", createdBy: "user:me", movedToAnotherBoard: true })])
    expect((await screen.findByTestId("task-moved-label")).textContent).toBe(MOVED)
    expect(await screen.findByTestId("task-composer")).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId("subtask-row-PLT-2")).toBeTruthy())
    for (const id of ["task-mark-done", "subtask-add", "task-title-edit"]) expect(screen.queryByTestId(id), id).toBeNull()
    expect(screen.getByTestId("rail-priority").closest("button")).toBeNull()
    // The board it left is not offered as where it is, and "visible to this board" would be untrue of it.
    expect(screen.queryByTestId("task-visibility-hint")).toBeNull()
    expect(screen.queryByTestId("composer-visibility-hint")).toBeNull()
    expect(document.body.textContent).not.toMatch(/Platform board|moved to platform/i)
  })

  it("leads its crumb back to a board they hold, not to Everything", async () => {
    principal = member({ department: "design", role: "collaborator" })
    setup(moved())
    await screen.findByTestId("task-moved-label")
    await waitFor(() => expect(document.body.textContent).toMatch(/Design/))
    expect(screen.queryByText("Everything")).toBeNull()
  })

  it("keeps a viewer read-only: the label, and no composer", async () => {
    principal = member({ department: "design", role: "viewer" })
    setup(moved({ memberCanComment: false }))
    expect((await screen.findByTestId("task-moved-label")).textContent).toBe(MOVED)
    expect(screen.queryByTestId("task-composer")).toBeNull()
    expect(screen.queryByTestId("task-mark-done")).toBeNull()
  })

  it("comments by what the gateway says their role on the board they filed it on allows, whatever else they hold", async () => {
    principal = member({ department: "design", role: "viewer" }, { department: "platform", role: "owner" })
    setup(moved({ memberCanComment: false }))
    await screen.findByTestId("task-moved-label")
    expect(screen.queryByTestId("task-composer")).toBeNull()
  })

  it("does not mark a Todo that is still on their board", async () => {
    principal = member({ department: "platform", role: "collaborator" })
    setup(full("PLT-1"))
    await screen.findByTestId("task-title")
    expect(screen.queryByTestId("task-moved-label")).toBeNull()
  })
})

describe("the members-can-read hint", () => {
  it("shows by the composer and on the Todo for a member, and nothing pops up", async () => {
    principal = member({ department: "platform", role: "collaborator" })
    setup(full("PLT-1"))
    expect((await screen.findByTestId("task-visibility-hint")).textContent).toBe(HINT)
    expect((await screen.findByTestId("composer-visibility-hint")).textContent).toBe(HINT)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows for the operator on a board that has members, and not on one that has none", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockResolvedValue({ members: [{ userId: "me", displayName: "Mia Member", email: "m@example.test", initials: "MM", role: "viewer" }], invites: [] })
    const first = setup(full("PLT-1", { createdBy: "operator" }))
    expect((await screen.findByTestId("task-visibility-hint")).textContent).toBe(HINT)
    expect((await screen.findByTestId("composer-visibility-hint")).textContent).toBe(HINT)
    expect(getBoardRoster).toHaveBeenCalledWith("platform")
    first.unmount()
    getBoardRoster.mockResolvedValue({ members: [], invites: [] })
    setup(full("PLT-1", { createdBy: "operator" }))
    await screen.findByTestId("task-composer")
    await waitFor(() => expect(getBoardRoster).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("task-visibility-hint")).toBeNull()
    expect(screen.queryByTestId("composer-visibility-hint")).toBeNull()
  })
})

describe("the operator assigning or moving a Todo a member created", () => {
  async function openAssignee() {
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    return screen.findByTestId("picker-assignee")
  }

  it("is told, before choosing, what the change does to their access, and the choice still commits (another department's employee)", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING))
    expect(assignWorkItem).not.toHaveBeenCalled()
    fireEvent.click(within(picker).getByTestId("assignee-option-bob"))
    expect(assignWorkItem).toHaveBeenCalledWith("PLT-1", "bob")
  })

  it("is told nothing when naming the operator as the person responsible: that is no assignment and changes no one's access", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1"))
    fireEvent.click(await screen.findByTestId("rail-person"))
    const picker = await screen.findByTestId("picker-person")
    expect(within(picker).queryByTestId("picker-member-creator-note")).toBeNull()
    fireEvent.click(within(picker).getByTestId("person-option-operator"))
    expect(assignWorkItem).not.toHaveBeenCalled()
  })

  it("is told the same when assigning within the board", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING))
    fireEvent.click(within(picker).getByTestId("assignee-option-alice"))
    expect(assignWorkItem).toHaveBeenCalledWith("PLT-1", "alice")
  })

  it("is told they keep reading but not commenting when they hold the board it was filed on as a viewer", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockResolvedValue(roster("viewer"))
    setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING_READ))
    expect(getBoardRoster).toHaveBeenCalledWith("platform")
  })

  it("is told they will lose access when they no longer hold the board it was filed on, or none is recorded", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockResolvedValue(roster())
    const first = setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING_NONE))
    first.unmount()
    getBoardRoster.mockResolvedValue(roster("owner"))
    setup(full("PLT-1"), [], null)
    const again = await openAssignee()
    await waitFor(() => expect(within(again).getByTestId("picker-member-creator-note").textContent).toBe(WARNING_NONE))
  })

  it("is told they will lose access when their account is disabled, though the roster still lists them", async () => {
    principal = { kind: "operator" }
    listPeople.mockResolvedValue([{ id: "me", email: "mia@example.test", displayName: "Mia Member", initials: "MM", status: "disabled" }])
    setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING_NONE))
  })

  it("says nothing until it knows what they keep", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockReturnValue(new Promise(() => {}))
    setup(full("PLT-1"))
    const picker = await openAssignee()
    await waitFor(() => expect(getBoardRoster).toHaveBeenCalled())
    expect(within(picker).queryByTestId("picker-member-creator-note")).toBeNull()
  })

  it("is told when moving it to another department", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1"))
    fireEvent.click(await screen.findByTestId("rail-department"))
    const picker = await screen.findByTestId("picker-department")
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING))
  })

  it("is told for a sub-task too, since its root is the member's", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1"), [full("PLT-2", { parentId: "PLT-1", createdBy: "operator" })])
    const row = await screen.findByTestId("subtask-row-PLT-2")
    fireEvent.mouseEnter(row)
    fireEvent.click(within(row).getByLabelText(/assign/i))
    const picker = await screen.findByTestId("subtask-assign-picker-PLT-2")
    await waitFor(() => expect(within(picker).getByTestId("picker-member-creator-note").textContent).toBe(WARNING))
  })

  it("tells the operator who reads an open Todo a member created, wherever it sits, and not once it is closed", async () => {
    principal = { kind: "operator" }
    const first = setup(full("PLT-1", { department: null }))
    await waitFor(() => expect(screen.getByTestId("task-creator-hint").textContent).toBe("Visible to Mia Member, who created it"))
    expect(screen.getByTestId("composer-creator-hint").textContent).toBe("Visible to Mia Member, who created it")
    expect(screen.queryByTestId("task-visibility-hint")).toBeNull() // the company board has no members of its own
    first.unmount()
    setup(full("PLT-1", { department: null, status: "done", closedAt: "2026-07-24T08:00:00.000Z" }))
    await screen.findByTestId("task-title")
    await waitFor(() => expect(getWorkItemTree).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("task-creator-hint")).toBeNull()
  })

  it("names no reader once the creator has lost access: removed from the board it was filed on, or disabled", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockResolvedValue(roster())
    const first = setup(full("PLT-1", { department: null }))
    await waitFor(() => expect(getBoardRoster).toHaveBeenCalled())
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    await screen.findByTestId("task-title")
    expect(screen.queryByTestId("task-creator-hint")).toBeNull()
    expect(screen.queryByTestId("composer-creator-hint")).toBeNull()
    first.unmount()
    getBoardRoster.mockResolvedValue(roster("collaborator"))
    listPeople.mockClear()
    listPeople.mockResolvedValue([{ id: "me", email: "mia@example.test", displayName: "Mia Member", initials: "MM", status: "disabled" }])
    setup(full("PLT-1", { department: null }))
    await screen.findByTestId("task-title")
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    expect(screen.queryByTestId("task-creator-hint")).toBeNull()
  })

  it("does not call a root on the company board the board of its sub-task", async () => {
    principal = { kind: "operator" }
    getBoardRoster.mockResolvedValue(roster("collaborator"))
    // The sub-task was made on a board; its root has since gone to the company board.
    getWorkItem.mockImplementation(async (id: string) => ({
      workItem: id === "PLT-2" ? full("PLT-2", { parentId: "PLT-1", rootId: "PLT-1", createdBy: "operator", department: "platform", depth: 1 }) : full("PLT-1", { department: null }),
      spendUsd: 0,
      events: [{ id: "e1", workItemId: id, kind: "created", fromStatus: null, toStatus: "backlog", actor: "connector", detail: { createdOnBoard: "platform" }, createdAt: "2026-07-20T08:00:00.000Z" }],
    }))
    getWorkItemTree.mockResolvedValue({ tree: { root: node(full("PLT-1", { department: null }), [node(full("PLT-2", { parentId: "PLT-1", rootId: "PLT-1", createdBy: "operator", department: "platform", depth: 1 }))]), totals: { backlog: 2 }, spendUsd: 0 } })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/todos/PLT-2"]}><Routes><Route path="/todos/:todoId" element={<TaskPage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByTestId("task-title")
    await waitFor(() => expect(screen.getByTestId("task-creator-hint")).toBeTruthy())
    expect(screen.queryByTestId("task-visibility-hint")).toBeNull()
  })

  it("says nothing about a Todo the operator or an employee made", async () => {
    principal = { kind: "operator" }
    setup(full("PLT-1", { createdBy: "operator" }))
    const picker = await openAssignee()
    expect(within(picker).queryByTestId("picker-member-creator-note")).toBeNull()
  })
})
