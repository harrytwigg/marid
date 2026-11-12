import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render as rtlRender, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { activeFilterCount, filtersFromSearchParams, filtersToSearchParams } from "@/lib/todos"
import { FilterBar } from "../filter-bar"
import { personFilterLabel, usePersonMatch } from "../person-filter"
import { agentFilterLabel, OPERATOR_ASSIGNEE, UNASSIGNED_FILTER } from "../util"

/* The board filters by the person and by the agent as two independent filters, ANDed. Each has its own chip, its own rows
 * and its own active chip; neither one's choice clears the other's. */

const auth = vi.hoisted(() => ({ value: null as unknown }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
const listPeople = vi.hoisted(() => vi.fn())
const getMemberPeople = vi.hoisted(() => vi.fn())
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: { listPeople, getMemberPeople } }))
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: { ...actual.api, listLabels: vi.fn().mockResolvedValue({ labels: [] }) } }
})

function render(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrap = (node: React.ReactElement) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
  const result = rtlRender(wrap(ui))
  return { ...result, rerender: (next: React.ReactElement) => result.rerender(wrap(next)) }
}

const originalMatchMedia = window.matchMedia
function setMobile(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(max-width: 767px)" ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

beforeEach(() => {
  auth.value = null
  listPeople.mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia })
})

const employee = { name: "some-employee", displayName: "Some Employee", department: "platform" } as Employee
const byName = new Map([[employee.name, employee]])

function person(id: string, displayName: string, over: Record<string, unknown> = {}) {
  return { id, email: `${id}@example.test`, displayName, initials: displayName.split(" ").map((word) => word[0]).join(""), instanceRole: "member", status: "active", boards: [], ...over }
}

function bar(filters: Parameters<typeof FilterBar>[0]["filters"], onChange = vi.fn(), extra: Partial<Parameters<typeof FilterBar>[0]> = {}) {
  return <FilterBar filters={filters} onChange={onChange} employees={[employee]} departments={[]} byName={byName} hideStatus board {...extra} />
}

function open(testId: string) {
  const chip = screen.getByTestId(testId)
  fireEvent.pointerDown(chip, { button: 0, pointerType: "mouse" })
  fireEvent.click(chip)
}

const rows = async () => (await screen.findAllByRole("menuitem")).map((item) => item.textContent)

describe("labels", () => {
  const me = { me: OPERATOR_ASSIGNEE, people: [{ id: "u1", displayName: "Pat Doe", initials: "PD" }], offerOperator: false }
  it("reads the person slot: Me, No person, a name; a person who is gone reads generically", () => {
    expect(personFilterLabel(undefined, me)).toBeNull()
    expect(personFilterLabel(OPERATOR_ASSIGNEE, me)).toBe("Me")
    expect(personFilterLabel(UNASSIGNED_FILTER, me)).toBe("No person")
    expect(personFilterLabel("user:u1", me)).toBe("Pat Doe")
    expect(personFilterLabel("user:gone", me)).toBe("Someone else")
  })
  it("reads the agent slot: No agent, a roster name, the raw name when it left the roster", () => {
    expect(agentFilterLabel(undefined, byName)).toBeNull()
    expect(agentFilterLabel(UNASSIGNED_FILTER, byName)).toBe("No agent")
    expect(agentFilterLabel("some-employee", byName)).toBe("Some Employee")
    expect(agentFilterLabel("gone-employee", byName)).toBe("gone-employee")
    // An old Assigned to me link filters the agent slot on the operator.
    expect(agentFilterLabel(OPERATOR_ASSIGNEE, byName)).toBe("Operator")
  })
  it("a member reads themself as Me and the operator as Operator", () => {
    const member = { me: "user:u1", people: [], offerOperator: true }
    expect(personFilterLabel("user:u1", member)).toBe("Me")
    expect(personFilterLabel(OPERATOR_ASSIGNEE, member)).toBe("Operator")
  })
})

describe("the board row has a Person chip and an Agent chip, and no Assignee chip", () => {
  it("shows both, unset", () => {
    setMobile(false)
    render(bar({ status: "open" }))
    expect(screen.getByTestId("filter-chip-person").textContent).toContain("Person")
    expect(screen.getByTestId("filter-chip-agent").textContent).toContain("Agent")
    expect(screen.queryByTestId("filter-chip-assignee")).toBeNull()
  })

  it("Person on an instance with no accounts offers Anyone, Me and No person, and asks for no people", async () => {
    setMobile(false)
    render(bar({ status: "open" }))
    open("filter-chip-person")
    expect(await rows()).toEqual(["Anyone", "Me", "No person"])
    expect(listPeople).not.toHaveBeenCalled()
  })

  it("Agent offers Anyone, No agent, then each employee", async () => {
    setMobile(false)
    render(bar({ status: "open" }))
    open("filter-chip-agent")
    const labels = await rows()
    expect(labels.slice(0, 2)).toEqual(["Anyone", "No agent"])
    expect(labels).toHaveLength(3)
    expect(labels[2]).toContain("Some Employee")
  })
})

describe("on an instance with accounts", () => {
  beforeEach(() => {
    auth.value = { principal: null, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([
      person("u1", "Pat Doe", { boards: [{ department: "platform", role: "collaborator" }] }),
      person("u2", "Sam Roe", { boards: [{ department: "other", role: "collaborator" }] }),
      person("u3", "Owen Poe", { instanceRole: "owner" }),
      person("u4", "Gone Goe", { status: "disabled", boards: [{ department: "platform", role: "viewer" }] }),
    ])
  })

  // The one owner is the operator: "Me" already filters on it, so its account is not listed again.
  it("a department board offers its own people, not the others, the disabled or the operator's own owner account", async () => {
    setMobile(false)
    render(bar({ status: "open" }, vi.fn(), { personBoard: "platform" }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    await waitFor(async () => expect(await rows()).toEqual(["Anyone", "Me", "No person", "PDPat Doe"]))
  })

  it("Everything offers every active person but the operator's own owner account", async () => {
    setMobile(false)
    render(bar({ status: "open" }, vi.fn(), { personBoard: null }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    await waitFor(async () => expect(await rows()).toEqual(["Anyone", "Me", "No person", "PDPat Doe", "SRSam Roe"]))
  })

  it("an old link filtering on the owner's own account still reads its name", async () => {
    setMobile(false)
    render(bar({ status: "open", person: "user:u3" }, vi.fn(), { personBoard: null }))
    await waitFor(() => expect(screen.getByTestId("filter-chip-person").textContent).toContain("Owen Poe"))
  })

  // Several owners share the desk: it is not "Me" to any one of them, and each owner, this browser's included, is a person by name.
  it("with several owners, the desk reads Operator (shared) and every owner is listed, the signed-in one too", async () => {
    auth.value = { principal: { kind: "operator", user: { id: "u3", displayName: "Owen Poe" } }, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([person("u1", "Pat Doe"), person("u3", "Owen Poe", { instanceRole: "owner" }), person("u5", "Ola Toe", { instanceRole: "owner" })])
    setMobile(false)
    const onChange = vi.fn()
    const { rerender } = render(bar({ status: "open" }, onChange, { personBoard: null }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    await waitFor(async () => expect(await rows()).toEqual(["Anyone", "Operator (shared)", "No person", "PDPat Doe", "OPOwen Poe", "OTOla Toe"]))
    fireEvent.click(screen.getByText("Operator (shared)"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", person: OPERATOR_ASSIGNEE, q: undefined })
    rerender(bar({ status: "open", person: OPERATOR_ASSIGNEE }, onChange, { personBoard: null }))
    await waitFor(() => expect(screen.getByTestId("filter-chip-person").textContent).toContain("Operator (shared)"))
  })

  it("with several owners and none of them this browser, the desk reads Operator (shared) and every owner is listed", async () => {
    listPeople.mockResolvedValue([person("u3", "Owen Poe", { instanceRole: "owner" }), person("u5", "Ola Toe", { instanceRole: "owner" })])
    setMobile(false)
    render(bar({ status: "open" }, vi.fn(), { personBoard: null }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    await waitFor(async () => expect(await rows()).toEqual(["Anyone", "Operator (shared)", "No person", "OPOwen Poe", "OTOla Toe"]))
  })

  it("the mobile filter sheet reads the shared desk the same way", async () => {
    listPeople.mockResolvedValue([person("u3", "Owen Poe", { instanceRole: "owner" }), person("u5", "Ola Toe", { instanceRole: "owner" })])
    setMobile(true)
    const onChange = vi.fn()
    render(<FilterBar filters={{ status: "open" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} personBoard={null} />)
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    fireEvent.click(await screen.findByRole("button", { name: "Person" }))
    expect(screen.queryByRole("button", { name: /^Me/ })).toBeNull()
    fireEvent.click(await screen.findByRole("button", { name: /^Operator \(shared\)/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", person: OPERATOR_ASSIGNEE, q: undefined })
  })

  it("lists nobody by name while the People read is pending, so the owner never shows beside Me", async () => {
    listPeople.mockReturnValue(new Promise(() => {}))
    setMobile(false)
    render(bar({ status: "open" }, vi.fn(), { personBoard: null }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    expect(await rows()).toEqual(["Anyone", "Me", "No person"])
  })

  it("picking a person sets that user's identity, and the chip reads their name", async () => {
    setMobile(false)
    const onChange = vi.fn()
    const { rerender } = render(bar({ status: "open" }, onChange, { personBoard: "platform" }))
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    open("filter-chip-person")
    fireEvent.click(await screen.findByText("Pat Doe"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", person: "user:u1", q: undefined })
    rerender(bar({ status: "open", person: "user:u1" }, onChange, { personBoard: "platform" }))
    await waitFor(() => expect(screen.getByTestId("filter-chip-person").textContent).toContain("Pat Doe"))
  })
})

describe("a member's Person filter", () => {
  beforeEach(() => {
    auth.value = { principal: { kind: "member", user: { id: "u1" }, boards: [] }, authState: { hasAccounts: true } }
  })
  it("Me is the signed-in member, and the operator is offered as a person to read", async () => {
    setMobile(false)
    const onChange = vi.fn()
    getMemberPeople.mockResolvedValue({ people: [{ id: "u2", displayName: "Sam Roe", initials: "SR" }] })
    render(bar({ status: "open" }, onChange))
    open("filter-chip-person")
    await waitFor(async () => expect(await rows()).toEqual(["Anyone", "Me", "No person", "Operator", "SRSam Roe"]))
    fireEvent.click(screen.getByText("Me"))
    expect(onChange).toHaveBeenCalledWith({ status: "open", person: "user:u1", q: undefined })
  })
})

describe("the two filters are independent and combine", () => {
  it("choosing Me keeps the agent, and choosing an agent keeps the person", () => {
    setMobile(false)
    const onChange = vi.fn()
    const { rerender } = render(bar({ status: "open", agent: "some-employee" }, onChange))
    open("filter-chip-person")
    fireEvent.click(screen.getByText("Me"))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", agent: "some-employee", person: OPERATOR_ASSIGNEE, q: undefined })

    rerender(bar({ status: "open", person: OPERATOR_ASSIGNEE }, onChange))
    open("filter-chip-agent")
    fireEvent.click(screen.getByText("No agent"))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", person: OPERATOR_ASSIGNEE, agent: UNASSIGNED_FILTER, q: undefined })
  })

  it("both chips read their own value at once", () => {
    setMobile(false)
    render(bar({ status: "open", person: OPERATOR_ASSIGNEE, agent: "some-employee" }))
    expect(screen.getByTestId("filter-chip-person").textContent).toContain("Me")
    expect(screen.getByTestId("filter-chip-agent").textContent).toContain("Some Employee")
  })

  it.each([
    ["Person", "Me", { person: OPERATOR_ASSIGNEE }],
    ["Person", "No person", { person: UNASSIGNED_FILTER }],
    ["Agent", "No agent", { agent: UNASSIGNED_FILTER }],
    ["Agent", "Some Employee", { agent: "some-employee" }],
  ])("%s: %s clears back to Anyone without touching the other slot", (slot, _label, value) => {
    setMobile(false)
    const onChange = vi.fn()
    const other = slot === "Person" ? { agent: "some-employee" } : { person: OPERATOR_ASSIGNEE }
    render(bar({ status: "open", ...value, ...other }, onChange))
    open(slot === "Person" ? "filter-chip-person" : "filter-chip-agent")
    fireEvent.click(screen.getAllByText("Anyone")[0])
    expect(onChange).toHaveBeenCalledWith({ status: "open", ...other, [slot === "Person" ? "person" : "agent"]: undefined, q: undefined })
  })

  it("the active-filter chips are separate and each removes only itself", () => {
    setMobile(false)
    const onChange = vi.fn()
    render(<FilterBar filters={{ status: "open", person: UNASSIGNED_FILTER, agent: "some-employee" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />)
    const active = screen.getByLabelText("Active filters").textContent
    expect(active).toContain("Person: No person")
    expect(active).toContain("Agent: Some Employee")
    fireEvent.click(screen.getByRole("button", { name: "Remove Person: No person" }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", agent: "some-employee", person: undefined, q: undefined })
    fireEvent.click(screen.getByRole("button", { name: "Remove Agent: Some Employee" }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", person: UNASSIGNED_FILTER, agent: undefined, q: undefined })
  })

  it("each counts as its own active filter and survives the URL round trip", () => {
    for (const filters of [
      { status: "open" as const, person: OPERATOR_ASSIGNEE },
      { status: "open" as const, agent: UNASSIGNED_FILTER },
      { status: "open" as const, person: "user:u1", agent: "some-employee" },
    ]) {
      expect(activeFilterCount(filters)).toBe(Object.keys(filters).length - 1)
      expect(filtersFromSearchParams(filtersToSearchParams(filters))).toEqual(filters)
    }
  })
})

describe("the refine menu of the list view", () => {
  it("offers Person and Agent as two submenus", () => {
    setMobile(false)
    render(<FilterBar filters={{ status: "open" }} onChange={vi.fn()} employees={[employee]} departments={[]} byName={byName} />)
    const trigger = screen.getByRole("button", { name: "Filter todos" })
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" })
    fireEvent.click(trigger)
    const triggers = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(triggers).toContain("Person")
    expect(triggers).toContain("Agent")
  })
})

describe("the mobile sheet", () => {
  it("has a Person panel and an Agent panel, each reading its own value", async () => {
    setMobile(true)
    const onChange = vi.fn()
    const { rerender } = render(<FilterBar filters={{ status: "open" }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />)
    fireEvent.click(screen.getByRole("button", { name: "Filter todos" }))
    fireEvent.click(await screen.findByRole("button", { name: "Person" }))
    fireEvent.click(screen.getByRole("button", { name: /^Me/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", person: OPERATOR_ASSIGNEE, q: undefined })

    rerender(<FilterBar filters={{ status: "open", person: OPERATOR_ASSIGNEE }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />)
    expect(screen.getByRole("button", { name: "Person" }).textContent).toContain("Me")
    expect(screen.getByRole("button", { name: "Agent" }).textContent).toContain("Anyone")
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    fireEvent.click(screen.getByRole("button", { name: /^No agent/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", person: OPERATOR_ASSIGNEE, agent: UNASSIGNED_FILTER, q: undefined })

    rerender(<FilterBar filters={{ status: "open", person: OPERATOR_ASSIGNEE, agent: UNASSIGNED_FILTER }} onChange={onChange} employees={[employee]} departments={[]} byName={byName} />)
    fireEvent.click(screen.getByRole("button", { name: "Person" }))
    fireEvent.click(screen.getByRole("button", { name: /^Anyone/ }))
    expect(onChange).toHaveBeenLastCalledWith({ status: "open", agent: UNASSIGNED_FILTER, person: undefined, q: undefined })
  })
})

describe("what the board asks the list for", () => {
  const match = (person: string | undefined) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderHook(() => usePersonMatch(person), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  }

  it("with one owner, Me also takes the Todos that name that owner's account", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([person("u1", "Pat Doe"), person("u3", "Owen Poe", { instanceRole: "owner" })])
    const { result } = match(OPERATOR_ASSIGNEE)
    await waitFor(() => expect(result.current).toBe("@operator,user:u3"))
  })

  it("asks for Me as it is until the People read lands, then widens", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { hasAccounts: true } }
    let land!: (people: unknown) => void
    listPeople.mockReturnValue(new Promise((resolve) => { land = resolve }))
    const { result } = match(OPERATOR_ASSIGNEE)
    expect(result.current).toBe(OPERATOR_ASSIGNEE)
    land([person("u3", "Owen Poe", { instanceRole: "owner" })])
    await waitFor(() => expect(result.current).toBe("@operator,user:u3"))
  })

  it("with several owners the shared desk is only the desk, and a named person is only that person", async () => {
    auth.value = { principal: { kind: "operator", user: { id: "u3", displayName: "Owen Poe" } }, authState: { hasAccounts: true } }
    listPeople.mockResolvedValue([person("u3", "Owen Poe", { instanceRole: "owner" }), person("u5", "Ola Toe", { instanceRole: "owner" })])
    const desk = match(OPERATOR_ASSIGNEE)
    await waitFor(() => expect(listPeople).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(desk.result.current).toBe(OPERATOR_ASSIGNEE)
    expect(match("user:u3").result.current).toBe("user:u3")
  })

  it("leaves every value alone with no accounts, and for a member, and asks for no people", () => {
    expect(match(OPERATOR_ASSIGNEE).result.current).toBe(OPERATOR_ASSIGNEE)
    auth.value = { principal: { kind: "member", user: { id: "u1" }, boards: [] }, authState: { hasAccounts: true } }
    expect(match(OPERATOR_ASSIGNEE).result.current).toBe(OPERATOR_ASSIGNEE)
    expect(match(undefined).result.current).toBeUndefined()
    expect(listPeople).not.toHaveBeenCalled()
  })
})
