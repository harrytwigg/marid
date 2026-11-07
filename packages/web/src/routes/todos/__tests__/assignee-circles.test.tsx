import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render as plainRender, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire } from "@/lib/api"
import { BoardCard } from "../board/card"
import { TodoListRow } from "../list/list-row"

/* The two circles on a card and a list row: the person left, the agent right, a dashed
 * outline for an empty slot, on every Todo, with no accounts on the instance too. */

/** Every surface is drawn inside a query client, as the app does: a member circle reads the people directory. */
const render = (ui: React.ReactElement) => plainRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const auth = vi.hoisted(() => ({ value: null as unknown }))
const directory = vi.hoisted(() => ({ listPeople: vi.fn(), getMemberPeople: vi.fn() }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
vi.mock("@/lib/accounts-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/accounts-api")>()), accountsApi: directory }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {}, operatorEmoji: "" } }) }))

function compact(over: Partial<WorkItemCompactWire> = {}): WorkItemCompactWire {
  return {
    id: "TSK-1", version: 1, title: "A Todo", status: "backlog", assignee: null, department: "platform", source: "human", sourceRef: null,
    createdBy: "operator", updatedAt: "2026-07-20T08:00:00.000Z", ...over,
  } as WorkItemCompactWire
}
const byName = new Map([["mason", { name: "mason", displayName: "Mason" }]]) as never

const surfaces: Array<[string, (item: WorkItemCompactWire) => void]> = [
  ["board card", (item) => void render(<BoardCard item={item} byName={byName} expanded={false} onToggleTree={() => {}} onOpen={() => {}} onOpenChild={() => {}} />)],
  ["list row", (item) => void render(<TodoListRow item={item} priority={2} byName={byName} now={Date.now()} onOpen={() => {}} />)],
]

const WITH_ACCOUNTS = { principal: null, authState: { accountsEnabled: true, hasAccounts: true } }

beforeEach(() => {
  vi.clearAllMocks()
  auth.value = WITH_ACCOUNTS
  directory.listPeople.mockResolvedValue([{ id: "ada1", displayName: "Ada Lovelace", initials: "AL" }])
})

describe.each(surfaces)("on the %s", (_name, draw) => {
  it("draws two dashed circles for a Todo with neither a person nor an agent, and asks the people directory nothing", () => {
    draw(compact())
    const pair = screen.getByTestId("assignee-circles")
    expect([...pair.children].map((child) => child.getAttribute("data-testid"))).toEqual(["person-circle-empty", "agent-circle-empty"])
    expect(screen.getByTitle("No person")).toBeTruthy()
    expect(screen.getByTitle("No agent")).toBeTruthy()
    expect(directory.listPeople).not.toHaveBeenCalled()
  })

  it("puts the person on the left and the agent on the right", () => {
    draw(compact({ assignee: "mason", humanAssignee: "@operator" }))
    const pair = screen.getByTestId("assignee-circles")
    expect([...pair.children].map((child) => child.getAttribute("data-testid"))).toEqual(["person-circle", "agent-circle"])
    expect(within(pair).getByTitle("Mason")).toBeTruthy()
    expect(within(pair).getByTitle("You (operator)")).toBeTruthy()
  })

  it("reads a Todo assigned to the operator as the operator in the person circle and an empty agent circle", () => {
    draw(compact({ assignee: "@operator", humanAssignee: "@operator" }))
    expect(screen.getByTestId("person-circle")).toBeTruthy()
    expect(screen.getByTestId("agent-circle-empty")).toBeTruthy()
    expect(screen.queryByTestId("agent-circle")).toBeNull()
  })

  it("draws a board member as a human avatar, named once the directory answers", async () => {
    draw(compact({ humanAssignee: "user:ada1" }))
    await waitFor(() => expect(screen.getByTestId("human-avatar").getAttribute("aria-label")).toBe("Ada Lovelace"))
    expect(screen.getByTestId("agent-circle-empty")).toBeTruthy()
  })

  it("draws a person no longer on the member's boards as a former member", () => {
    auth.value = { principal: { kind: "member", user: { id: "me", email: "m@example.test", displayName: "Mia" }, boards: [] }, authState: { accountsEnabled: true, hasAccounts: true } }
    draw(compact({ humanAssignee: "member" }))
    expect(screen.getByTestId("human-avatar").getAttribute("aria-label")).toBe("Former member")
    expect(directory.getMemberPeople).not.toHaveBeenCalled()
  })
})

describe.each(surfaces)("on the %s of an instance with no accounts", (_name, draw) => {
  beforeEach(() => { auth.value = { principal: null, authState: { accountsEnabled: true, hasAccounts: false } } })

  it("is today's: no pair, one circle for the agent, nothing at all for a Todo nobody holds", () => {
    draw(compact({ assignee: "mason", humanAssignee: "@operator" }))
    expect(screen.queryByTestId("assignee-circles")).toBeNull()
    expect(screen.queryByTestId("person-circle")).toBeNull()
    expect(screen.getByTitle("Mason")).toBeTruthy()
  })

  it("draws no circle, dashed or otherwise, for an unassigned Todo", () => {
    draw(compact())
    expect(screen.queryByTestId("assignee-circles")).toBeNull()
    expect(screen.queryByTitle("No person")).toBeNull()
    expect(screen.queryByTitle("No agent")).toBeNull()
  })

  it("draws a Todo assigned to the operator as the one assignee circle, as it always did", () => {
    draw(compact({ assignee: "@operator", humanAssignee: "@operator" }))
    expect(screen.queryByTestId("person-circle")).toBeNull()
    expect(screen.getByTitle("@operator")).toBeTruthy()
  })
})
