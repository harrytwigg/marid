import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { NewTodoDialog } from "../new-todo-dialog"

/* What the create dialog does once the Todo exists: every slot it collected is tried, a board member before a cross-board
 * agent, and any slot left unset is named, with the form cleared so another click cannot create the Todo again. */

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

describe("the New Todo dialog after the Todo exists", () => {
  it("names a board member before the agent, so an agent from another board cannot strand the person", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    updateWorkItem.mockResolvedValueOnce({ workItem: { id: "TSK-9", version: 2 }, replayed: false })
    assignWorkItem.mockResolvedValueOnce({ workItem: { id: "TSK-9", version: 3 } })
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Across boards")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-ada1"))
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-create"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(updateWorkItem).toHaveBeenCalledWith("TSK-9", expect.objectContaining({ patch: { humanAssignee: "user:ada1" }, expectedVersion: 1 }))
    expect(assignWorkItem).toHaveBeenCalledWith("TSK-9", "mason")
    expect(updateWorkItem.mock.invocationCallOrder[0]).toBeLessThan(assignWorkItem.mock.invocationCallOrder[0])
  })

  it("still names the agent when naming a board member fails, and says only the person is unset", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    updateWorkItem.mockRejectedValueOnce(new Error("no grant"))
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Grant revoked")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-ada1"))
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-create"))
    expect(await screen.findByText("Created TSK-9, but couldn't set the person. Set it on the Todo.")).toBeTruthy()
    expect(assignWorkItem).toHaveBeenCalledWith("TSK-9", "mason")
  })

  it("names both slots when neither could be set", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: true } }
    listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }])
    updateWorkItem.mockRejectedValueOnce(new Error("no grant"))
    assignWorkItem.mockRejectedValueOnce(new Error("refused"))
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Neither")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-ada1"))
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-create"))
    expect(await screen.findByText("Created TSK-9, but couldn't set the agent and person. Set it on the Todo.")).toBeTruthy()
  })

  it("still names you as the person when the agent's assignment fails, and says only the agent is unset", async () => {
    assignWorkItem.mockRejectedValueOnce(new Error("refused"))
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Agent refused, you kept")
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    await user.click(screen.getByTestId("todo-new-create"))
    expect(await screen.findByText("Created TSK-9, but couldn't set the agent. Set it on the Todo.")).toBeTruthy()
    expect(updateWorkItem).toHaveBeenCalledWith("TSK-9", expect.objectContaining({ patch: { humanAssignee: "@operator" }, expectedVersion: 1 }))
  })

  it("says it was the agent that could not be set when the agent's assignment fails", async () => {
    assignWorkItem.mockRejectedValueOnce(new Error("refused"))
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Agent refused")
    await user.click(screen.getByTestId("todo-new-assignee-chip"))
    await user.click(await screen.findByTestId("assignee-option-mason"))
    await user.click(screen.getByTestId("todo-new-create"))
    expect(await screen.findByText("Created TSK-9, but couldn't set the agent. Set it on the Todo.")).toBeTruthy()
    expect(createWorkItem).toHaveBeenCalledTimes(1)
  })

  it("keeps the created Todo and never creates it again when naming who it is for fails", async () => {
    assignWorkItem.mockRejectedValueOnce(new Error("refused"))
    const user = userEvent.setup()
    const { onCreated } = renderDialog()
    await user.type(screen.getByTestId("todo-new-title"), "Half done")
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    await user.click(screen.getByTestId("todo-new-create"))
    expect(await screen.findByText("Created TSK-9, but couldn't set the person. Set it on the Todo.")).toBeTruthy()
    expect(screen.getByTestId("todo-new-create")).toHaveProperty("disabled", true)
    await user.click(screen.getByTestId("todo-new-create"))
    expect(createWorkItem).toHaveBeenCalledTimes(1)
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByTestId("todo-new-person-chip").textContent).not.toContain("You (operator)")
  })

  it("asks before discarding a draft whose only choice is the person", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NewTodoDialog onClose={onClose} onCreated={vi.fn()} defaults={{ employees, departments, department: "platform" }} />
      </QueryClientProvider>,
    )
    await user.click(screen.getByTestId("todo-new-person-chip"))
    await user.click(await screen.findByTestId("person-option-operator"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByText("Discard this Todo draft?")).toBeTruthy()
  })
})
