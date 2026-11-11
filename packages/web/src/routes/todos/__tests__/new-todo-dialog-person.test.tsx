import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { NewTodoDialog } from "../new-todo-dialog"

/* The create dialog has the two slots the Todo page has: the agent first, then the person. Picking yourself as the person
 * with no agent is the create-assigned-to-you the dialog always offered, so it goes through the assign route and stores
 * `@operator`; every other choice goes through the assign route (agent) and the pen (person). */

const auth = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
const createWorkItem = vi.fn()
const assignWorkItem = vi.fn()
const updateWorkItem = vi.fn()
const listPeople = vi.hoisted(() => vi.fn())
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: { listPeople } }))
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      ...actual.api,
      createWorkItem: (...args: unknown[]) => createWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
    },
  }
})

const employees: Employee[] = [{ name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" }]
const departments = [{ slug: "platform", prefix: "TSK", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }]

function renderDialog() {
  const onCreated = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewTodoDialog onClose={vi.fn()} onCreated={onCreated} defaults={{ employees, departments, department: "platform" }} />
    </QueryClientProvider>,
  )
  return { onCreated }
}

beforeEach(() => {
  vi.clearAllMocks()
  auth.value = null
  createWorkItem.mockResolvedValue({ workItem: { id: "TSK-9", version: 1 } })
  assignWorkItem.mockResolvedValue({ workItem: { id: "TSK-9", version: 2 } })
  updateWorkItem.mockResolvedValue({ workItem: { id: "TSK-9", version: 3 }, replayed: false })
})

describe("the New Todo dialog's two slots, on an instance with no accounts", () => {
  it("puts the agent chip before the person chip", () => {
    renderDialog()
    const chips = screen.getAllByTestId(/^todo-new-(assignee|person)-chip$/).map((chip) => chip.dataset.testid)
    expect(chips).toEqual(["todo-new-assignee-chip", "todo-new-person-chip"])
    expect(screen.getByTestId("todo-new-assignee-chip").textContent).toContain("Agent")
    expect(screen.getByTestId("todo-new-person-chip").textContent).toContain("Person")
  })

  it("lists exactly the operator in the person picker, and the agent picker offers employees only", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-person-chip"))
    const picker = await screen.findByTestId("todo-new-person-picker")
    expect([...picker.querySelectorAll('[data-testid^="person-option-"]')].map((row) => row.textContent)).toEqual(["🌈You (operator)"])
    expect(within(picker).queryByText(/No one else has access/)).toBeNull()
    expect(listPeople).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    const agents = await screen.findByTestId("todo-new-assignee-picker")
    expect(within(agents).queryByTestId("assignee-option-@operator")).toBeNull()
    expect(within(agents).getByTestId("assignee-option-mason")).toBeTruthy()
  })

  it("creates a Todo assigned to you through the assign route, as it always did", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Mine")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    expect(screen.getByTestId("todo-new-person-chip").textContent).toContain("You (operator)")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(assignWorkItem).toHaveBeenCalledTimes(1)
    expect(assignWorkItem).toHaveBeenCalledWith("TSK-9", "@operator")
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("names the agent through the assign route and then yourself as the person through the pen", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Both")
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(assignWorkItem).toHaveBeenCalledWith("TSK-9", "mason")
    expect(updateWorkItem).toHaveBeenCalledWith("TSK-9", expect.objectContaining({ patch: { humanAssignee: "@operator" }, expectedVersion: 2 }))
    expect(assignWorkItem.mock.invocationCallOrder[0]).toBeLessThan(updateWorkItem.mock.invocationCallOrder[0])
  })

  it("makes no assignment at all when neither slot is chosen", async () => {
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Nobody")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(assignWorkItem).not.toHaveBeenCalled()
    expect(updateWorkItem).not.toHaveBeenCalled()
  })
})

describe("the New Todo dialog's person picker, on an instance with accounts", () => {
  it("offers you and the board's people, and names a person without touching the agent slot", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "For Ada")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    expect(await screen.findByTestId("person-option-operator")).toBeTruthy()
    await user.click(await screen.findByTestId("person-option-ada1"))
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(assignWorkItem).not.toHaveBeenCalled()
    expect(updateWorkItem).toHaveBeenCalledWith("TSK-9", expect.objectContaining({ patch: { humanAssignee: "user:ada1" }, expectedVersion: 1 }))
  })

  it("lets a board member go as the person when the draft moves off their board", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Moved")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-ada1"))
    await user.click(screen.getByTestId("todo-new-department-chip"))
    await user.click(await screen.findByTestId("department-option-none"))
    expect(screen.getByTestId("todo-new-person-chip").textContent).not.toContain("Ada")
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(updateWorkItem).not.toHaveBeenCalled()
    expect(assignWorkItem).not.toHaveBeenCalled()
  })

  it("keeps you as the person when the draft moves to another board", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([])
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    await user.click(screen.getByTestId("todo-new-department-chip"))
    await user.click(await screen.findByTestId("department-option-none"))
    expect(screen.getByTestId("todo-new-person-chip").textContent).toContain("You (operator)")
  })

  it("offers the instance owners on a draft with no board, and says to choose a board only when no one is left", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([
      { id: "own1", displayName: "Olive Owner", initials: "OO", status: "active", instanceRole: "owner", boards: [] },
      { id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] },
    ])
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-department-chip"))
    await user.click(await screen.findByTestId("department-option-none"))
    await user.click(screen.getByTestId("todo-new-person-chip"))
    const picker = await screen.findByTestId("todo-new-person-picker")
    expect(await within(picker).findByTestId("person-option-own1")).toBeTruthy()
    expect(within(picker).queryByTestId("person-option-ada1")).toBeNull()
    expect(within(picker).queryByText(/Choose a board/)).toBeNull()
  })

  it("says to choose a board, not that nobody has access, when a draft with no board has no one to offer", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("todo-new-department-chip"))
    await user.click(await screen.findByTestId("department-option-none"))
    await user.click(screen.getByTestId("todo-new-person-chip"))
    const picker = await screen.findByTestId("todo-new-person-picker")
    expect(await within(picker).findByText("Choose a board to name someone else.")).toBeTruthy()
    expect(within(picker).queryByText(/No one else has access/)).toBeNull()
    expect(within(picker).queryByTestId("person-option-ada1")).toBeNull()
  })
})
