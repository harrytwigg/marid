import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemDetailWire, WorkItemFullWire, WorkItemTreeNodeWire } from "@/lib/api"
import TaskPage from "../task-page/task-page"

/* Dropping an agent is a one-tap action, not a scroll to the bottom of the
 * roster: Unassign is pinned above the agents, and both surfaces that show one
 * (the properties rail, the chip cluster) carry their own × that commits
 * through the picker's exact lane. Every case runs on an instance with no
 * accounts (no auth state at all), which shows the agent and the person slots
 * like any other. */

vi.mock("@/components/page-layout", () => ({ PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))

const getWorkItem = vi.fn()
const getWorkItemTree = vi.fn()
const updateWorkItem = vi.fn()
const assignWorkItem = vi.fn().mockResolvedValue({ workItem: {} })

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      getWorkItem: (...args: unknown[]) => getWorkItem(...args),
      getWorkItemTree: (...args: unknown[]) => getWorkItemTree(...args),
      updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
      assignWorkItem: (...args: unknown[]) => assignWorkItem(...args),
      setWorkItemStatus: vi.fn(),
      setWorkItemLabels: vi.fn(),
      listLabels: vi.fn().mockResolvedValue({ labels: [] }),
      listWorkItemSessions: vi.fn().mockResolvedValue([]),
      getDepartments: vi.fn().mockResolvedValue({
        departments: [{ slug: "platform", prefix: "TSK", createdAt: "2026-07-01T00:00:00.000Z", todoCount: 4 }],
      }),
      getOrg: vi.fn().mockResolvedValue({
        departments: ["platform"],
        employees: [
          { name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" },
          { name: "scout", displayName: "Scout", department: "marketing", rank: "employee", engine: "codex", model: "m", persona: "p" },
          // A system employee is on the roster but never offered as an assignee.
          { name: "todo-dispatcher", displayName: "Todo Dispatcher", department: "system", rank: "senior", engine: "claude", model: "m", persona: "p", system: true },
        ],
        hierarchy: { root: null, sorted: [], warnings: [] },
      }),
      listWorkItems: vi.fn().mockResolvedValue({ workItems: [], total: 0, nextOffset: null }),
    },
  }
})

function full(id: string, overrides: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id, version: 3, title: `Item ${id}`, body: null, status: "executing", department: "platform",
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null,
    rounds: 1, budgetUsd: null,
    createdBy: "operator", parentId: null, rootId: id, depth: 0,
    dueAt: null, createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-23T08:00:00.000Z",
    closedAt: null, ...overrides,
  }
}

function detailOf(item: WorkItemFullWire): WorkItemDetailWire {
  return { workItem: item, spendUsd: 0, events: [] }
}

function treeNode(item: WorkItemFullWire, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { ...item, children }
}

function renderTask() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/todos/TSK-12"]}>
        <Routes>
          <Route path="/todos/:todoId" element={<TaskPage />} />
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
})

describe("the agent picker's Unassign row", () => {
  it("sits above every person, out of the roster's scroller, and is absent when nobody is assigned", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12", { assignee: "mason" })))
    const assigned = renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))

    const picker = await screen.findByTestId("picker-assignee")
    const rows = [...picker.querySelectorAll<HTMLElement>('[data-testid^="assignee-option-"]')]
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "assignee-option-unassign",
      "assignee-option-mason",
      "assignee-option-scout",
    ])
    // Outside the roster's scroll container: a long roster can never push it
    // out of reach, in the popover or in the sheet.
    expect(rows[0].parentElement).not.toBe(rows[1].parentElement)
    assigned.unmount()

    getWorkItem.mockResolvedValue(detailOf(full("TSK-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    await screen.findByTestId("assignee-option-mason")
    expect(screen.queryByTestId("assignee-option-unassign")).toBeNull()
  })
})

describe("the pickers of an instance with no accounts", () => {
  it("name the agent picker Agent and the person picker Person", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12", { assignee: "mason" })))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    expect((await screen.findByTestId("picker-assignee")).getAttribute("aria-label")).toBe("Agent")
    fireEvent.click(await screen.findByTestId("rail-person"))
    expect((await screen.findByTestId("picker-person")).getAttribute("aria-label")).toBe("Person")
  })
})

describe("clearing the assignee without opening a picker", () => {
  it("the rail's clear control commits the same null the picker's Unassign does", async () => {
    const item = full("TSK-12", { assignee: "mason" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, assignee: null, version: 4 }, replayed: false })
    renderTask()

    const clear = await screen.findByTestId("rail-assignee-clear")
    expect(clear.getAttribute("aria-label")).toBe("Remove agent")
    clear.focus()
    expect(document.activeElement).toBe(clear)

    fireEvent.click(clear)
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("TSK-12", expect.objectContaining({
        patch: { assignee: null },
        expectedVersion: 3,
      })),
    )
  })

  it("the chip's clear control commits it too, and both vanish once nobody is assigned", async () => {
    const item = full("TSK-12", { assignee: "mason" })
    const cleared = { ...item, assignee: null, version: 4 }
    // First load is assigned; every refetch after the gateway accepts the clear
    // returns the unassigned Todo, so this also proves the clear survives one.
    getWorkItem.mockResolvedValueOnce(detailOf(item))
    getWorkItem.mockResolvedValue(detailOf(cleared))
    updateWorkItem.mockResolvedValue({ workItem: cleared, replayed: false })
    renderTask()

    const clear = await screen.findByTestId("chip-assignee-clear")
    expect(clear.getAttribute("aria-label")).toBe("Remove agent")
    fireEvent.click(clear)
    await waitFor(() =>
      expect(updateWorkItem).toHaveBeenCalledWith("TSK-12", expect.objectContaining({
        patch: { assignee: null },
        expectedVersion: 3,
      })),
    )
    await waitFor(() => expect(screen.queryByTestId("chip-assignee-clear")).toBeNull())
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
  })

  it("offers nothing to clear when nobody is assigned", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12")))
    renderTask()

    await screen.findByTestId("rail-assignee")
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
    expect(screen.queryByTestId("chip-assignee-clear")).toBeNull()
  })
})

describe("the operator as the person, with no accounts", () => {
  it("is offered in the person picker beside 'No person', and the agent picker does not offer it", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-assignee"))
    await screen.findByTestId("assignee-option-mason")
    expect(screen.queryByTestId("assignee-option-@operator")).toBeNull()
    fireEvent.click(await screen.findByTestId("rail-assignee"))

    fireEvent.click(await screen.findByTestId("rail-person"))
    const picker = await screen.findByTestId("picker-person")
    const option = within(picker).getByTestId("person-option-operator")
    expect(option.textContent).toContain("You (operator)")
    // Nobody holds the person slot, so there is no "No person" row to offer yet; nobody else exists to name.
    expect(within(picker).queryByTestId("person-option-clear")).toBeNull()
    expect(within(picker).queryByText(/No one else has access/)).toBeNull()
  })

  it("writes picking yourself through today's assign-to-operator route when nobody holds either slot", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12")))
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-person"))
    fireEvent.click(await screen.findByTestId("person-option-operator"))
    await waitFor(() => expect(assignWorkItem).toHaveBeenCalledWith("TSK-12", "@operator"))
    expect(assignWorkItem).toHaveBeenCalledTimes(1)
    expect(updateWorkItem).not.toHaveBeenCalled()
  })

  it("writes picking yourself through the person write when an agent holds the Todo, so the agent stays", async () => {
    const item = full("TSK-12", { assignee: "mason" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, humanAssignee: "@operator", version: 4 }, replayed: false })
    renderTask()
    fireEvent.click(await screen.findByTestId("rail-person"))
    fireEvent.click(await screen.findByTestId("person-option-operator"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledWith("TSK-12", expect.objectContaining({ patch: { humanAssignee: "@operator" }, expectedVersion: 3 })))
    expect(assignWorkItem).not.toHaveBeenCalled()
  })

  it("offers 'No person' once the operator holds the slot, and clears it through today's unassign write", async () => {
    const item = full("TSK-12", { assignee: "@operator", humanAssignee: "@operator" })
    getWorkItem.mockResolvedValue(detailOf(item))
    updateWorkItem.mockResolvedValue({ workItem: { ...item, assignee: null, humanAssignee: null, version: 4 }, replayed: false })
    renderTask()
    expect((await screen.findByTestId("rail-person")).textContent).toContain("You (operator)")
    expect((await screen.findByTestId("rail-person-clear")).getAttribute("aria-label")).toBe("Remove person: takes it off your desk")
    fireEvent.click(await screen.findByTestId("rail-person"))
    expect((await screen.findByTestId("person-option-clear")).textContent).toContain("No person")
    fireEvent.click(screen.getByTestId("person-option-clear"))
    await waitFor(() => expect(updateWorkItem).toHaveBeenCalledWith("TSK-12", expect.objectContaining({ patch: { assignee: null } })))
    expect(assignWorkItem).not.toHaveBeenCalled()
  })

  it("reads a Todo assigned to the operator as the operator in both person surfaces and an empty agent", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12", { assignee: "@operator", humanAssignee: "@operator" })))
    renderTask()
    expect((await screen.findByTestId("chip-person")).textContent).toContain("You (operator)")
    expect((await screen.findByTestId("rail-person")).textContent).toContain("You (operator)")
    expect((await screen.findByTestId("chip-assignee")).textContent).toContain("No agent")
    expect(screen.queryByTestId("chip-assignee-clear")).toBeNull()
    expect(screen.queryByTestId("rail-assignee-clear")).toBeNull()
  })

  it("leaves one line for the operator assigned through one write, and a person set on its own keeps its line", async () => {
    const item = full("TSK-12", { assignee: "@operator" })
    const at = "2026-07-23T08:00:00.000Z"
    const events = [
      { id: "e1", workItemId: "TSK-12", kind: "note", fromStatus: null, toStatus: null, actor: "operator", detail: { assignee: "@operator" }, createdAt: at },
      { id: "e2", workItemId: "TSK-12", kind: "person_changed", fromStatus: null, toStatus: null, actor: "operator", detail: { from: null, to: "@operator", withAgent: true }, createdAt: at },
    ]
    getWorkItem.mockResolvedValue({ ...detailOf(item), events })
    renderTask()
    await screen.findByText(/assigned it to the operator/)
    expect(screen.queryByText(/named the operator as the person/)).toBeNull()
  })

  it("shows the person line when it was set by a write that did not assign anything", async () => {
    const item = full("TSK-12", { assignee: "mason", humanAssignee: "@operator" })
    const events = [
      { id: "e1", workItemId: "TSK-12", kind: "person_changed", fromStatus: null, toStatus: null, actor: "operator", detail: { from: null, to: "@operator" }, createdAt: "2026-07-23T08:00:00.000Z" },
    ]
    getWorkItem.mockResolvedValue({ ...detailOf(item), events })
    renderTask()
    expect(await screen.findByText(/named the operator as the person/)).toBeTruthy()
  })

  it("keeps 'Needs you' in the agent slot when the operator holds the agent slot beside no person row", async () => {
    getWorkItem.mockResolvedValue(detailOf(full("TSK-12", { assignee: "@operator" })))
    renderTask()
    expect((await screen.findByTestId("chip-assignee")).textContent).toContain("Needs you")
    expect((await screen.findByTestId("rail-assignee")).textContent).toContain("Needs you")
  })
})
