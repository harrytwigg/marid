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
import { TaskBanner } from "../task-page/banner"
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

  it("shows the person responsible as a human avatar in the person circle, beside the agent's empty one", async () => {
    card(compact({ createdBy: "user:ada1", source: "connector", humanAssignee: "user:ada1" }))
    const circles = screen.getByTestId("board-card-TSK-1").querySelector('[data-testid="assignee-circles"]')!
    await waitFor(() => expect(circles.querySelector('[data-testid="human-avatar"]')?.getAttribute("aria-label")).toBe("Ada Lovelace"))
    expect(circles.children[0].querySelector('[data-testid="human-avatar"]')).toBeTruthy()
    expect(circles.children[1].getAttribute("data-testid")).toBe("agent-circle-empty")
  })

  it("no longer puts a member-made card's creator in a free slot: only the person responsible is drawn", () => {
    card(compact({ createdBy: "user:ada1", source: "connector", humanAssignee: null }))
    const row = screen.getByTestId("board-card-TSK-1").children[0]
    expect(row.textContent).toBe("TSK-1")
    expect(screen.queryByTestId("human-avatar")).toBeNull()
    expect(screen.getByTestId("person-circle-empty")).toBeTruthy()
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

  it("names the operator as the Todo's creator and as the person responsible: Operator", () => {
    wrap(<PropsRail detail={detailOf({ item: { assignee: "@operator", humanAssignee: "@operator" } })} byName={new Map()} departments={[]} />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("Operator")
    expect(screen.getByTestId("rail-created-by").textContent).not.toContain("You")
    expect(screen.getByTestId("rail-person").textContent).toContain("Operator")
    expect(screen.getByTestId("rail-person").textContent).not.toContain("You")
    expect(screen.getByTestId("rail-assignee").textContent).toContain("No agent")
  })
})

describe("generic actors in a board member's view", () => {
  beforeEach(() => {
    auth.value = {
      principal: { kind: "member", user: { id: "mia1", email: "m@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "viewer" }] },
      authState: { accountsEnabled: true, hasAccounts: true },
    }
    directory.getMemberPeople.mockResolvedValue({ people: [ADA], employees: [] })
  })

  it("reads an agent's and the system's comments and audit lines as Agent and System, never the raw word", () => {
    renderActivity(detailOf({
      events: [
        event("wie_a", "metadata_edited", "2026-07-20T08:10:00.000Z", { actor: "agent" }),
        event("wie_s", "label_changed", "2026-07-20T08:20:00.000Z", { actor: "system" }),
        event("wie_n", "relation_added", "2026-07-20T08:30:00.000Z", { actor: null }),
      ],
      comments: {
        comments: [
          // Between the audit lines, so none of them fold together.
          comment("wic_a", "done it", "2026-07-20T08:15:00.000Z", { authorKind: "employee", author: "agent" }),
          comment("wic_s", "noted", "2026-07-20T08:25:00.000Z", { authorKind: "system", author: "system" }),
        ],
        total: 2,
      },
    }))
    expect(screen.getByTestId("whisper-wie_a").textContent).toMatch(/^Agent /)
    expect(screen.getByTestId("whisper-wie_s").textContent).toMatch(/^System /)
    expect(screen.getByTestId("whisper-wie_n").textContent).toMatch(/^System /)
    expect(screen.getByTestId("activity-comment-wic_a").textContent).toContain("Agent")
    expect(screen.getByTestId("activity-comment-wic_a").textContent).not.toContain("agent")
    expect(screen.getByTestId("activity-comment-wic_s").textContent).toContain("System")
  })

  it("names an agent-made Todo's creator Agent, and a system-made one System", () => {
    const { unmount } = wrap(<PropsRail detail={detailOf({ item: { createdBy: "agent", source: "session" } })} byName={new Map()} departments={[]} />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("Agent")
    unmount()
    wrap(<PropsRail detail={detailOf({ item: { createdBy: "system", source: "cron" } })} byName={new Map()} departments={[]} />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("System")
  })

  it("names who blocked a Todo on its banner: a person by name, the operator as Operator", async () => {
    const blocked = (actor: string) => detailOf({
      item: { status: "blocked" },
      events: [event("wie_b", "status_change", "2026-07-20T09:00:00.000Z", { actor, fromStatus: "executing", toStatus: "blocked" })],
    })
    const { unmount } = wrap(<TaskBanner detail={blocked("user:ada1")} byName={new Map()} focusReason={false} busy={false} onCommitReason={() => {}} />)
    await waitFor(() => expect(document.body.textContent).toContain("Ada Lovelace"))
    expect(document.body.textContent).not.toContain("user:ada1")
    unmount()
    wrap(<TaskBanner detail={blocked("operator")} byName={new Map()} focusReason={false} busy={false} onCommitReason={() => {}} />)
    expect(document.body.textContent).toContain("Operator")
  })

  it("leaves the operator's own view as it was", () => {
    auth.value = ACCOUNTS
    renderActivity(detailOf({ events: [event("wie_s", "metadata_edited", "2026-07-20T08:20:00.000Z", { actor: "system" })] }))
    expect(screen.getByTestId("whisper-wie_s").textContent).toMatch(/^The gateway /)
  })
})

describe("the generic member actor", () => {
  beforeEach(() => {
    auth.value = {
      principal: { kind: "member", user: { id: "mia1", email: "m@example.test", displayName: "Mia Member" }, boards: [{ department: "platform", role: "viewer" }] },
      authState: { accountsEnabled: true, hasAccounts: true },
    }
  })

  it("reads as Former member with the unknown-person badge on comments and audit lines, and asks the directory nothing", () => {
    renderActivity(detailOf({
      events: [event("wie_m", "status_change", "2026-07-20T08:10:00.000Z", { actor: "member", fromStatus: "backlog", toStatus: "in_review" })],
      comments: {
        comments: [
          comment("wic_k", "from someone gone", "2026-07-20T08:15:00.000Z", { authorKind: "member", author: "member" }),
          comment("wic_e", "however it is stamped", "2026-07-20T08:20:00.000Z", { authorKind: "employee", author: "member" }),
        ],
        total: 2,
      },
    }))
    for (const id of ["activity-comment-wic_k", "activity-comment-wic_e", "whisper-wie_m"]) {
      const block = screen.getByTestId(id)
      expect(block.textContent, id).toContain("Former member")
      expect(block.textContent, id).not.toMatch(/(?<!Former )member moved|^\??member/)
      expect(block.querySelector('[data-testid="human-avatar"]')?.textContent, id).toBe("?")
    }
    expect(directory.getMemberPeople).not.toHaveBeenCalled()
  })

  it("reads as Former member as a Todo's creator and on its blocked banner", () => {
    const { unmount } = wrap(<PropsRail detail={detailOf({ item: { createdBy: "member", source: "connector" } })} byName={new Map()} departments={[]} />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("Former member")
    unmount()
    wrap(<TaskBanner
      detail={detailOf({ item: { status: "blocked" }, events: [event("wie_b", "status_change", "2026-07-20T09:00:00.000Z", { actor: "member", fromStatus: "backlog", toStatus: "blocked" })] })}
      byName={new Map()} focusReason={false} busy={false} onCommitReason={() => {}}
    />)
    expect(document.body.textContent).toContain("Former member")
    expect(directory.getMemberPeople).not.toHaveBeenCalled()
  })
})

describe("an employee called member, in the operator's view", () => {
  const bot = new Map([["member", { name: "member", displayName: "Membership Bot" } as never]])

  it("is that employee, not a former member, on comments, audit lines and the creator row", () => {
    wrap(<ActivitySection
      detail={detailOf({
        events: [event("wie_m", "metadata_edited", "2026-07-20T08:10:00.000Z", { actor: "member" })],
        comments: { comments: [comment("wic_m", "beep", "2026-07-20T08:15:00.000Z", { authorKind: "employee", author: "member" })], total: 1 },
      })}
      byName={bot} mobile={false} announce={vi.fn()}
    />)
    expect(screen.getByTestId("activity-comment-wic_m").textContent).toContain("Membership Bot")
    expect(screen.getByTestId("whisper-wie_m").textContent).toContain("Membership Bot")
    expect(document.body.textContent).not.toContain("Former member")
    expect(screen.queryByTestId("human-avatar")).toBeNull()
  })

  it("names them as a Todo's creator, with no last-touched line", () => {
    wrap(<PropsRail
      detail={detailOf({ item: { createdBy: "member" }, events: [event("wie_m", "metadata_edited", "2026-07-20T08:10:00.000Z", { actor: "member" })] })}
      byName={bot} departments={[]}
    />)
    expect(screen.getByTestId("rail-created-by").textContent).toContain("Membership Bot")
    expect(screen.queryByTestId("last-touched-by")).toBeNull()
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
