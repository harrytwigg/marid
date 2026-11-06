import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import { OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { comment, event } from "./fixtures/task-wire"

/* A board member is stamped `user:<id>` on comments, events and createdBy. These pin that such an
 * identity renders as a person (badge + name), that the operator and employees render as before,
 * and that an instance without accounts never asks the directory anything. */

const { settings, auth, directory } = vi.hoisted(() => ({
  settings: { operatorEmoji: null as string | null, employeeOverrides: {} },
  auth: { value: null as unknown },
  directory: { listPeople: vi.fn(), getMemberPeople: vi.fn() },
}))

vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings }) }))
vi.mock("@/routes/providers", () => ({ useTheme: () => ({ theme: "dark" }) }))
vi.mock("@/routes/auth-provider", () => ({ useAuthOptional: () => auth.value }))
vi.mock("@/lib/accounts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounts-api")>()
  return { ...actual, accountsApi: { ...actual.accountsApi, listPeople: directory.listPeople, getMemberPeople: directory.getMemberPeople } }
})
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItemComments: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
      listWorkItemAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
      addWorkItemComment: vi.fn(),
      editWorkItemComment: vi.fn(),
      deleteWorkItemComment: vi.fn(),
      uploadWorkItemAttachment: vi.fn(),
      workItemAttachmentUrl: (id: string, aid: string) => `/api/work-items/${id}/attachments/${aid}`,
    },
  }
})

import { ActivitySection } from "../task-page/activity"
import { PropsRail } from "../task-page/props-rail"
import { BoardCard } from "../board/card"
import { lastMemberToucher, withCreatorActor } from "../attribution"

const ADA = { id: "ada1", displayName: "Ada Lovelace", initials: "AL" }
const ACCOUNTS = { principal: null, authState: { accountsEnabled: true, hasAccounts: true } }

function fullItem(over: Partial<WorkItemFullWire> = {}): WorkItemFullWire {
  return {
    id: "TSK-12", version: 1, title: "Item", body: null, status: "backlog", department: "platform",
    assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, rounds: 0, budgetUsd: null,
    createdBy: "operator", parentId: null, rootId: "TSK-12", depth: 0, dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z", updatedAt: "2026-07-20T08:00:00.000Z", closedAt: null, ...over,
  } as WorkItemFullWire
}

function detailOf(over: Partial<WorkItemDetailWire> & { item?: Partial<WorkItemFullWire> } = {}): WorkItemDetailWire {
  const { item, ...rest } = over
  return { workItem: fullItem(item), spendUsd: 0, events: [], comments: { comments: [], total: 0 }, ...rest } as unknown as WorkItemDetailWire
}

function wrap(node: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>)
}

const renderActivity = (detail: WorkItemDetailWire) =>
  wrap(<ActivitySection detail={detail} byName={new Map([["mason", { name: "mason", displayName: "Mason" } as never]])} mobile={false} announce={vi.fn()} />)

beforeEach(() => {
  auth.value = ACCOUNTS
  directory.listPeople.mockReset().mockResolvedValue([{ ...ADA, email: "a@example.test", instanceRole: "member", status: "active", boards: [] }])
  directory.getMemberPeople.mockReset().mockResolvedValue({ people: [ADA], employees: [] })
})

describe("comments", () => {
  const withComments = (...comments: ReturnType<typeof comment>[]) =>
    detailOf({ comments: { comments, total: comments.length } })

  it("shows a member's comment with a person badge and their display name", async () => {
    renderActivity(withComments(comment("wic_a", "hello", "2026-07-20T09:00:00.000Z", { authorKind: "member", author: "user:ada1" })))
    const block = screen.getByTestId("activity-comment-wic_a")
    await waitFor(() => expect(block.textContent).toContain("Ada Lovelace"))
    expect(block.querySelector('[data-testid="human-avatar"]')?.textContent).toBe("AL")
    expect(block.textContent).not.toContain("You")
  })

  it("reads an older gateway's `system` comment by a user as the person, not as System", async () => {
    renderActivity(withComments(comment("wic_a", "hello", "2026-07-20T09:00:00.000Z", { authorKind: "system", author: "user:ada1" })))
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_a").textContent).toContain("Ada Lovelace"))
    expect(screen.getByTestId("activity-comment-wic_a").textContent).not.toContain("System")
  })

  it("names an unknown or removed user \"Former member\"", async () => {
    renderActivity(withComments(comment("wic_a", "hello", "2026-07-20T09:00:00.000Z", { authorKind: "member", author: "user:gone9" })))
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_a").textContent).toContain("Former member"))
    expect(screen.getByTestId("activity-comment-wic_a").querySelector('[data-testid="human-avatar"]')?.textContent).toBe("?")
  })

  it("shows no name, and no guess, while the directory has not answered", async () => {
    directory.listPeople.mockReturnValue(new Promise(() => {}))
    renderActivity(withComments(comment("wic_a", "hello", "2026-07-20T09:00:00.000Z", { authorKind: "member", author: "user:ada1" })))
    const block = screen.getByTestId("activity-comment-wic_a")
    expect(block.querySelector('[data-testid="human-avatar-pending"]')).toBeTruthy()
    expect(block.textContent).not.toMatch(/Former member|Ada/)
  })

  it("leaves the operator's comment as You with their emoji, and an employee's as their name, with no person badge", async () => {
    renderActivity(withComments(
      comment("wic_o", "mine", "2026-07-20T09:00:00.000Z", { authorKind: "operator", author: "operator" }),
      comment("wic_e", "theirs", "2026-07-20T09:01:00.000Z", { authorKind: "employee", author: "mason" }),
    ))
    const operator = screen.getByTestId("activity-comment-wic_o")
    const employee = screen.getByTestId("activity-comment-wic_e")
    expect(operator.textContent).toContain("You")
    expect(operator.textContent).toContain(OPERATOR_DEFAULT_EMOJI)
    expect(employee.textContent).toContain("Mason")
    expect(screen.queryByTestId("human-avatar")).toBeNull()
    expect(directory.listPeople).not.toHaveBeenCalled()
  })
})

describe("audit lines", () => {
  it("names a member actor by display name", async () => {
    renderActivity(detailOf({ events: [event("wie_1", "metadata_edited", "2026-07-20T09:00:00.000Z", { actor: "user:ada1" })] }))
    await waitFor(() => expect(screen.getByTestId("whisper-wie_1").textContent).toContain("Ada Lovelace"))
    expect(screen.getByTestId("whisper-wie_1").textContent).toContain("edited the details")
  })

  it("reads the birth line of a member-made Todo as the person, not the connector the store records", async () => {
    renderActivity(detailOf({
      item: { createdBy: "user:ada1", source: "connector" },
      events: [event("wie_1", "created", "2026-07-20T08:00:00.000Z", { actor: "connector" })],
    }))
    await waitFor(() => expect(screen.getByTestId("whisper-wie_1").textContent).toContain("Ada Lovelace"))
    expect(screen.getByTestId("whisper-wie_1").textContent).not.toContain("connector")
  })

  it("keeps an operator event as You", () => {
    renderActivity(detailOf({ events: [event("wie_1", "metadata_edited", "2026-07-20T09:00:00.000Z")] }))
    expect(screen.getByTestId("whisper-wie_1").textContent).toContain("You")
  })

  it("finds the last member to touch a Todo only when the newest line is theirs", () => {
    const mine = event("a", "metadata_edited", "2026-07-20T09:00:00.000Z", { actor: "user:ada1" })
    const later = event("b", "status_change", "2026-07-20T10:00:00.000Z", { actor: "operator" })
    expect(lastMemberToucher([mine])).toBe("user:ada1")
    expect(lastMemberToucher([mine, later])).toBeNull()
    expect(withCreatorActor([event("c", "created", "x", { actor: "connector" })], "operator")[0].actor).toBe("connector")
  })
})

describe("the Todo page's created-by row", () => {
  const rail = (detail: WorkItemDetailWire) =>
    wrap(<PropsRail detail={detail} byName={new Map()} departments={[]} />)

  it("shows the person who made it, and who touched it last", async () => {
    rail(detailOf({
      item: { createdBy: "user:ada1", source: "connector" },
      events: [event("wie_1", "metadata_edited", "2026-07-20T09:00:00.000Z", { actor: "user:ada1" })],
    }))
    await waitFor(() => expect(screen.getByTestId("rail-created-by").textContent).toContain("Ada Lovelace"))
    expect(screen.getByTestId("last-touched-by").textContent).toContain("Ada Lovelace")
  })

  it("keeps the operator's Todo as You, with no last-touched line", () => {
    rail(detailOf())
    expect(screen.getByTestId("rail-created-by").textContent).toContain("You")
    expect(screen.queryByTestId("last-touched-by")).toBeNull()
    expect(directory.listPeople).not.toHaveBeenCalled()
  })
})

describe("the board card", () => {
  const compact = (over: Partial<WorkItemCompactWire>): WorkItemCompactWire => ({
    id: "TSK-1", version: 1, title: "A card", status: "backlog", assignee: null, department: "platform",
    source: "human", sourceRef: null, createdBy: "operator", parentId: null, rootId: "TSK-1", depth: 0,
    dueAt: null, labels: [], blocked: false, updatedAt: "2026-07-20T08:00:00.000Z", rank: null, ...over,
  })
  const card = (item: WorkItemCompactWire) =>
    wrap(<BoardCard item={item} byName={new Map()} expanded={false} onToggleTree={() => {}} onOpen={() => {}} onOpenChild={() => {}} onAddSubTask={() => {}} />)

  it("shows a member-made, unassigned card's creator in the assignee slot", async () => {
    card(compact({ createdBy: "user:ada1", source: "connector" }))
    const row = screen.getByTestId("board-card-TSK-1").children[0]
    await waitFor(() => expect(row.textContent).toContain("Ada Lovelace"))
    expect(row.querySelector('[data-testid="human-avatar"]')).toBeTruthy()
  })

  it("leaves operator- and employee-made cards exactly as they were, and asks the directory nothing", () => {
    card(compact({}))
    expect(screen.getByTestId("board-card-TSK-1").children[0].textContent).toBe("TSK-1")
    expect(screen.queryByTestId("human-avatar")).toBeNull()
    expect(directory.listPeople).not.toHaveBeenCalled()
  })
})

describe("an instance without accounts", () => {
  it("renders the activity feed and a card without reading the people directory", () => {
    auth.value = null
    renderActivity(detailOf({
      events: [event("wie_1", "metadata_edited", "2026-07-20T09:00:00.000Z")],
      comments: { comments: [comment("wic_o", "mine", "2026-07-20T09:00:00.000Z", { authorKind: "operator", author: "operator" })], total: 1 },
    }))
    expect(screen.getByTestId("activity-comment-wic_o").textContent).toContain("You")
    auth.value = { principal: null, authState: { accountsEnabled: true, hasAccounts: false } }
    wrap(<BoardCard item={{ id: "TSK-2", title: "t", status: "backlog", assignee: null, department: "platform", source: "human", sourceRef: null, createdBy: "operator", updatedAt: "2026-07-20T08:00:00.000Z" } as WorkItemCompactWire} byName={new Map()} expanded={false} onToggleTree={() => {}} onOpen={() => {}} onOpenChild={() => {}} onAddSubTask={() => {}} />)
    expect(directory.listPeople).not.toHaveBeenCalled()
    expect(directory.getMemberPeople).not.toHaveBeenCalled()
  })
})

describe("in a board member's view", () => {
  const MIA = { id: "mia1", displayName: "Mia Member", initials: "MM" }
  beforeEach(() => {
    auth.value = {
      principal: { kind: "member", user: { id: "mia1", email: "m@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "collaborator" }] },
      authState: { accountsEnabled: true, hasAccounts: true },
    }
    directory.getMemberPeople.mockResolvedValue({ people: [ADA, MIA], employees: [] })
  })

  it("names the operator's comments and audit lines Operator, never You, beside the member's own name", async () => {
    renderActivity(detailOf({
      events: [event("wie_s", "status_change", "2026-07-20T08:30:00.000Z", { actor: "operator", fromStatus: "backlog", toStatus: "executing" })],
      comments: {
        comments: [
          comment("wic_o", "Operator says hi", "2026-07-20T09:00:00.000Z", { authorKind: "operator", author: "operator" }),
          comment("wic_m", "mine", "2026-07-20T09:01:00.000Z", { authorKind: "member", author: "user:mia1" }),
        ],
        total: 2,
      },
    }))
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_m").textContent).toContain("Mia Member"))
    expect(screen.getByTestId("activity-comment-wic_o").textContent).toContain("Operator")
    expect(screen.getByTestId("activity-comment-wic_o").textContent).not.toContain("You")
    expect(screen.getByTestId("whisper-wie_s").textContent).toContain("Operator")
    expect(screen.getByTestId("whisper-wie_s").textContent).not.toContain("You")
  })

  it("names the operator as the Todo's creator and assignee Operator", () => {
    wrap(<PropsRail detail={detailOf({ item: { assignee: "@operator" } })} byName={new Map()} departments={[]} />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("Operator")
    expect(screen.getByTestId("rail-created-by").textContent).not.toContain("You")
    expect(screen.getByTestId("rail-assignee").textContent).toContain("Operator")
    expect(screen.getByTestId("rail-assignee").textContent).not.toContain("You")
  })
})

describe("a person who joined after the operator's page loaded", () => {
  const NIA = { id: "nia1", displayName: "Nia New", initials: "NN", email: "n@example.test", instanceRole: "member", status: "active", boards: [] }
  const withComment = (author: string) =>
    detailOf({ comments: { comments: [comment("wic_n", "hello", "2026-07-20T09:00:00.000Z", { authorKind: "member", author })], total: 1 } })
  const byName = new Map([["mason", { name: "mason", displayName: "Mason" } as never]])

  it("is named once an account exists, even though the page loaded when there were none", async () => {
    auth.value = { principal: { kind: "operator" }, authState: { accountsEnabled: true, hasAccounts: false } }
    directory.listPeople.mockResolvedValue([NIA])
    renderActivity(withComment("user:nia1"))
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_n").textContent).toContain("Nia New"))
  })

  it("asks the directory again rather than calling a newcomer a former member", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // Read before the invite was accepted: nobody yet.
    client.setQueryData(["people-directory", "operator"], { people: [], employees: [] }, { updatedAt: Date.now() - 5_000 })
    directory.listPeople.mockResolvedValue([NIA])
    wrap(<ActivitySection detail={withComment("user:nia1")} byName={byName} mobile={false} announce={vi.fn()} />, client)
    const block = screen.getByTestId("activity-comment-wic_n")
    expect(block.textContent).not.toContain("Former member")
    await waitFor(() => expect(block.textContent).toContain("Nia New"))
    expect(directory.listPeople).toHaveBeenCalledTimes(1)
  })

  it("is a former member when the fresh read does not know them either", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(["people-directory", "operator"], { people: [], employees: [] }, { updatedAt: Date.now() - 5_000 })
    directory.listPeople.mockResolvedValue([])
    wrap(<ActivitySection detail={withComment("user:gone9")} byName={byName} mobile={false} announce={vi.fn()} />, client)
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_n").textContent).toContain("Former member"))
    expect(directory.listPeople).toHaveBeenCalledTimes(1)
  })

  it("is a former member when the fresh read fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(["people-directory", "operator"], { people: [], employees: [] }, { updatedAt: Date.now() - 5_000 })
    directory.listPeople.mockRejectedValue(new Error("down"))
    wrap(<ActivitySection detail={withComment("user:nia1")} byName={byName} mobile={false} announce={vi.fn()} />, client)
    await waitFor(() => expect(screen.getByTestId("activity-comment-wic_n").textContent).toContain("Former member"))
  })
})
