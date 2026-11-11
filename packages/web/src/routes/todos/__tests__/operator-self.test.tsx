import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render as plainRender, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { workItemNode } from "./fixtures/task-wire"
import { PersonCircle, PersonName } from "../assignee-circles"
import { AssigneePickerContent } from "../pickers/picker-contents"
import { PersonPickerContent } from "../pickers/person-picker-content"

/* The operator's own account in the person slot (docs/design/board-members.md): with no active owner account `@operator` is
 * "You (operator)" as it always was and nothing new is asked; with one it is that owner; with several it is "Operator (shared)".
 * The account this browser is reads "<name> (you)", still stores `@operator`, and is never listed again as a `user:` person. */

const auth = vi.hoisted(() => ({ value: null as unknown }))
const accounts = vi.hoisted(() => ({ listPeople: vi.fn(), getMemberPeople: vi.fn() }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: accounts }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {}, operatorEmoji: "" } }) }))

const render = (ui: React.ReactElement) => plainRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const olive = { id: "own1", displayName: "Olive Owner", initials: "OO", email: "olive@example.test", status: "active", instanceRole: "owner", boards: [] }
const omar = { id: "own2", displayName: "Omar Owner", initials: "OW", email: "omar@example.test", status: "active", instanceRole: "owner", boards: [] }
const ada = { id: "ada1", displayName: "Ada Lovelace", initials: "AL", email: "ada@example.test", status: "active", instanceRole: "member", boards: [{ department: "platform", role: "collaborator" }] }
const gone = { ...omar, id: "own3", displayName: "Gone Owner", status: "disabled" }

type Browser = "linked-to-olive" | "linked-to-omar" | "unlinked" | "member" | "no-accounts"
function as(browser: Browser) {
  if (browser === "no-accounts") auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: false } }
  else if (browser === "member") auth.value = { principal: { kind: "member", user: { id: "ada1", email: "ada@example.test", displayName: "Ada Lovelace" }, boards: [{ department: "platform", role: "collaborator" }] }, authState: { accountsEnabled: true, hasAccounts: true } }
  else {
    const user = browser === "linked-to-olive" ? { id: "own1", displayName: "Olive Owner" } : browser === "linked-to-omar" ? { id: "own2", displayName: "Omar Owner" } : undefined
    auth.value = { principal: { kind: "operator", ...(user ? { user } : {}) }, authState: { accountsEnabled: true, hasAccounts: true } }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  as("no-accounts")
  accounts.listPeople.mockResolvedValue([])
  accounts.getMemberPeople.mockResolvedValue({ people: [], employees: [] })
})

function pickerRows() {
  return [...document.querySelectorAll<HTMLElement>('[data-testid^="person-option-"]')].map((row) => ({ id: row.dataset.testid!, text: row.textContent!, checked: !!row.querySelector("svg.ml-auto") }))
}

function renderPicker(humanAssignee: string | null, over: { assignee?: string | null } = {}) {
  const commit = vi.fn()
  const item = workItemNode("TSK-7", { department: "platform", humanAssignee, ...(over.assignee !== undefined ? { assignee: over.assignee } : {}) } as never)
  render(<PersonPickerContent detail={{ workItem: item, spendUsd: 0, events: [] }} commit={commit} onDone={vi.fn()} board="platform" />)
  return commit
}

describe("no active owner account: exactly as before", () => {
  it("offers You (operator) with the emoji, and asks the gateway for nothing, with no accounts at all", async () => {
    renderPicker("@operator")
    expect(pickerRows()).toEqual([{ id: "person-option-clear", text: "No person", checked: false }, { id: "person-option-operator", text: "🌈You (operator)", checked: true }])
    expect(accounts.listPeople).not.toHaveBeenCalled()
  })

  it("keeps You (operator) and the board's members where only members exist", async () => {
    as("unlinked")
    accounts.listPeople.mockResolvedValue([ada])
    renderPicker(null)
    await screen.findByTestId("person-option-ada1")
    expect(pickerRows().map((row) => row.text)).toEqual(["🌈You (operator)", "ALAda Lovelace"])
  })

  it("keeps the chip, the circle and the assign row on You (operator)", async () => {
    as("unlinked")
    accounts.listPeople.mockResolvedValue([ada])
    render(<><PersonCircle person="@operator" /><PersonName person="@operator" viewer="operator" /><AssigneePickerContent detail={{ workItem: workItemNode("TSK-7", { assignee: "@operator" }), spendUsd: 0, events: [] }} employees={[]} commit={vi.fn()} onDone={vi.fn()} offerOperator /></>)
    await waitFor(() => expect(accounts.listPeople).toHaveBeenCalled())
    expect(screen.getByTestId("person-circle").title).toBe("You (operator)")
    expect(screen.getAllByText("You (operator)").length).toBe(2)
    expect(screen.queryByTestId("human-avatar")).toBeNull()
  })

  it("asks nothing and reads You (operator) with no accounts at all, on the circle too", () => {
    render(<PersonCircle person="@operator" />)
    expect(screen.getByTestId("person-circle").title).toBe("You (operator)")
    expect(accounts.listPeople).not.toHaveBeenCalled()
  })
})

describe("one owner account", () => {
  beforeEach(() => accounts.listPeople.mockResolvedValue([olive, ada, gone]))

  it.each(["linked-to-olive", "unlinked"] as const)("a %s browser: the owner is the operator row, by name, and is not listed twice", async (browser) => {
    as(browser)
    const commit = renderPicker("@operator")
    await screen.findByTestId("person-option-ada1")
    expect(pickerRows()).toEqual([
      { id: "person-option-clear", text: "No person", checked: false },
      { id: "person-option-operator", text: "OOOlive Owner (you)", checked: true },
      { id: "person-option-ada1", text: "ALAda Lovelace", checked: false },
    ])
    expect(screen.queryByText("You (operator)")).toBeNull()
    fireEvent.click(screen.getByTestId("person-option-ada1"))
    expect(commit).toHaveBeenCalledWith("user:ada1")
  })

  it("choosing the owner's row stores @operator, never user:<id>", async () => {
    as("linked-to-olive")
    const commit = renderPicker("user:ada1")
    await screen.findByTestId("person-option-ada1")
    expect(pickerRows().find((row) => row.id === "person-option-ada1")!.checked).toBe(true)
    fireEvent.click(screen.getByTestId("person-option-operator"))
    expect(commit).toHaveBeenCalledWith("@operator")
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it("a Todo that already names user:<owner> shows the name, leaves the row unchecked, and choosing it writes @operator", async () => {
    as("linked-to-olive")
    const commit = renderPicker("user:own1")
    await screen.findByTestId("person-option-operator")
    expect(pickerRows().filter((row) => row.checked)).toEqual([])
    expect(screen.queryByTestId("person-option-own1")).toBeNull()
    fireEvent.click(screen.getByTestId("person-option-operator"))
    expect(commit).toHaveBeenCalledWith("@operator")
  })

  it("the chip, the circle and the legacy @operator value read as the owner, with the owner's avatar", async () => {
    as("unlinked")
    render(<><PersonCircle person="@operator" /><PersonName person="@operator" viewer="operator" /></>)
    await waitFor(() => expect(screen.getByTestId("person-circle").title).toBe("Olive Owner"))
    expect(screen.getByTestId("human-avatar").textContent).toBe("OO")
    expect(screen.getByText("Olive Owner")).toBeTruthy()
  })

  it("keeps the hand-on hints on the other people, and none on the owner's own row", async () => {
    as("linked-to-olive")
    renderPicker("@operator", { assignee: "@operator" })
    await screen.findByTestId("person-option-ada1")
    expect(screen.getByTestId("person-option-ada1").textContent).toContain("Takes it off your desk")
    expect(screen.getByTestId("person-option-operator").textContent).not.toContain("Takes it off your desk")
    expect(screen.getByTestId("person-option-clear").textContent).toContain("Takes it off your desk")
  })

  it("says so when nobody else can be named", async () => {
    as("linked-to-olive")
    accounts.listPeople.mockResolvedValue([olive])
    renderPicker(null)
    expect(await screen.findByText("No one else has access to this board.")).toBeTruthy()
    expect(pickerRows().map((row) => row.id)).toEqual(["person-option-operator"])
  })
})

describe("two owner accounts", () => {
  beforeEach(() => accounts.listPeople.mockResolvedValue([olive, omar, ada]))

  it("a browser linked to one owner sees '<name> (you)' for @operator (marked shared) and the other owner by name", async () => {
    as("linked-to-olive")
    const commit = renderPicker("@operator")
    await screen.findByTestId("person-option-own2")
    expect(pickerRows()).toEqual([
      { id: "person-option-clear", text: "No person", checked: false },
      { id: "person-option-operator", text: "OOOlive Owner (you)Operator (shared)", checked: true },
      { id: "person-option-own2", text: "OWOmar Owner", checked: false },
      { id: "person-option-ada1", text: "ALAda Lovelace", checked: false },
    ])
    expect(screen.queryByTestId("person-option-own1")).toBeNull()
    fireEvent.click(screen.getByTestId("person-option-own2"))
    expect(commit).toHaveBeenCalledWith("user:own2")
  })

  it("the other owner's browser sees itself as the 'you' row and the first owner by name", async () => {
    as("linked-to-omar")
    renderPicker(null)
    await screen.findByTestId("person-option-own1")
    expect(pickerRows().map((row) => row.text)).toEqual(["OWOmar Owner (you)Operator (shared)", "OOOlive Owner", "ALAda Lovelace"])
  })

  it("an unlinked browser sees a first 'Operator (shared)' row that stores @operator, and every owner by name", async () => {
    as("unlinked")
    const commit = renderPicker("@operator")
    await screen.findByTestId("person-option-own1")
    expect(pickerRows()).toEqual([
      { id: "person-option-clear", text: "No person", checked: false },
      { id: "person-option-operator", text: "🌈Operator (shared)", checked: true },
      { id: "person-option-own1", text: "OOOlive Owner", checked: false },
      { id: "person-option-own2", text: "OWOmar Owner", checked: false },
      { id: "person-option-ada1", text: "ALAda Lovelace", checked: false },
    ])
    fireEvent.click(screen.getByTestId("person-option-own1"))
    expect(commit).toHaveBeenCalledWith("user:own1")
  })

  it("the chip and the circle read Operator (shared) with the operator's emoji, the same in every owner's browser", async () => {
    for (const browser of ["linked-to-olive", "linked-to-omar", "unlinked"] as const) {
      as(browser)
      const { unmount } = render(<><PersonCircle person="@operator" /><PersonName person="@operator" viewer="operator" /></>)
      await waitFor(() => expect(screen.getByTestId("person-circle").title).toBe("Operator (shared)"))
      expect(screen.getByText("Operator (shared)")).toBeTruthy()
      expect(screen.queryByTestId("human-avatar")).toBeNull()
      unmount()
    }
  })
})

describe("what asks for the owners", () => {
  it("a circle with nobody in it asks nothing, even where accounts exist; one holding @operator asks once", async () => {
    as("unlinked")
    accounts.listPeople.mockResolvedValue([olive])
    const { unmount } = render(<><PersonCircle person={null} /><PersonCircle person={undefined} /></>)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getAllByTestId("person-circle-empty")).toHaveLength(2)
    expect(accounts.listPeople).not.toHaveBeenCalled()
    unmount()
    render(<><PersonCircle person="@operator" /><PersonCircle person="@operator" /></>)
    await waitFor(() => expect(screen.getAllByTestId("person-circle")[0]!.title).toBe("Olive Owner"))
    expect(accounts.listPeople).toHaveBeenCalledTimes(1)
  })
})

describe("a board member's view", () => {
  it("still reads Operator, and asks for no owners", () => {
    as("member")
    render(<><PersonCircle person="@operator" /><PersonName person="@operator" viewer="member" /></>)
    expect(screen.getByTestId("person-circle").title).toBe("Operator")
    expect(screen.getByText("Operator")).toBeTruthy()
    expect(accounts.listPeople).not.toHaveBeenCalled()
  })
})

describe("the assign rows with no person slot beside them", () => {
  const employees: Employee[] = [{ name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" }]
  const detail = { workItem: workItemNode("TSK-13", { assignee: "@operator" }), spendUsd: 0, events: [] }

  it("keeps the row and its assign write, named for the one owner, and finds it by that name", async () => {
    as("unlinked")
    accounts.listPeople.mockResolvedValue([olive, ada])
    const commit = vi.fn()
    render(<AssigneePickerContent detail={detail} employees={employees} commit={commit} onDone={vi.fn()} offerOperator />)
    await waitFor(() => expect(screen.getByTestId("assignee-option-@operator").textContent).toContain("Olive Owner"))
    const row = screen.getByTestId("assignee-option-@operator")
    expect(row.textContent).not.toContain("You (operator)")
    expect(row.querySelector("svg.ml-auto")).toBeTruthy()
    fireEvent.change(screen.getByTestId("assignee-search"), { target: { value: "olive" } })
    expect(screen.getByTestId("assignee-option-@operator")).toBeTruthy()
    fireEvent.change(screen.getByTestId("assignee-search"), { target: { value: "you (op" } })
    expect(screen.queryByTestId("assignee-option-@operator")).toBeNull()
    fireEvent.change(screen.getByTestId("assignee-search"), { target: { value: "" } })
    fireEvent.click(screen.getByTestId("assignee-option-unassign"))
    expect(commit).toHaveBeenCalledWith(null)
  })

  it("reads Operator (shared) with several owners, and assigns @operator through the same write", async () => {
    as("linked-to-olive")
    accounts.listPeople.mockResolvedValue([olive, omar])
    const commit = vi.fn()
    render(<AssigneePickerContent detail={{ ...detail, workItem: workItemNode("TSK-13", { assignee: null }) }} employees={employees} commit={commit} onDone={vi.fn()} offerOperator />)
    await waitFor(() => expect(screen.getByTestId("assignee-option-@operator").textContent).toContain("Operator (shared)"))
    fireEvent.change(screen.getByTestId("assignee-search"), { target: { value: "shared" } })
    fireEvent.click(screen.getByTestId("assignee-option-@operator"))
    expect(commit).toHaveBeenCalledWith("@operator")
  })

  it("is still You (operator) where there is no owner", async () => {
    as("unlinked")
    accounts.listPeople.mockResolvedValue([ada])
    render(<AssigneePickerContent detail={detail} employees={employees} commit={vi.fn()} onDone={vi.fn()} offerOperator />)
    await waitFor(() => expect(accounts.listPeople).toHaveBeenCalled())
    expect(screen.getByTestId("assignee-option-@operator").textContent).toContain("You (operator)")
  })
})
