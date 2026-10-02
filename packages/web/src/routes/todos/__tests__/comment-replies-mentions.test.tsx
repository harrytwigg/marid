import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Employee, WorkItemCommentWire, WorkItemDetailWire, WorkItemFullWire } from "@/lib/api"
import { comment } from "./fixtures/task-wire"

/* Replying to any comment, the line that says whom a flattened reply answered,
 * the @mention picker in the composer, and the chips in a comment body. */

const addWorkItemComment = vi.fn()

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    api: {
      listWorkItemAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
      listWorkItemComments: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
      addWorkItemComment: (...args: unknown[]) => addWorkItemComment(...args),
      uploadWorkItemAttachment: vi.fn(),
      editWorkItemComment: vi.fn(),
      deleteWorkItemComment: vi.fn(),
      workItemAttachmentUrl: (id: string, attachmentId: string) => `/api/work-items/${id}/attachments/${attachmentId}`,
    },
  }
})
vi.mock("@/routes/settings-provider", () => ({ useSettings: () => ({ settings: { employeeOverrides: {} } }) }))

import { ActivitySection } from "../task-page/activity"

const item = {
  id: "PLA-12", version: 1, title: "Item", body: null, status: "executing", department: null,
  assignee: null, priority: 2, rank: null, source: "human", sourceRef: null, acceptance: null,
  verifyPolicy: null, rounds: 0, budgetUsd: null, createdBy: "operator", parentId: null,
  rootId: "PLA-12", depth: 0, dueAt: null, createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:00:00.000Z", closedAt: null,
} as WorkItemFullWire

const emp = (name: string, displayName: string, system = false) => ({ name, displayName, system }) as Employee
const roster = new Map<string, Employee>(
  [
    emp("build-lead", "Build Lead"),
    emp("test-lead", "Test Lead"),
    emp("ops-bot", "Ops Bot", true),
    emp("mason", "Mason"),
  ].map((e) => [e.name, e]),
)

function renderThread(comments: WorkItemCommentWire[]) {
  const detail = {
    workItem: item,
    spendUsd: 0,
    events: [],
    comments: { comments, total: comments.length },
  } as unknown as WorkItemDetailWire
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ActivitySection detail={detail} byName={roster} mobile={false} announce={vi.fn()} />
    </QueryClientProvider>,
  )
}

const T1 = "2026-07-20T09:00:00.000Z"
const T2 = "2026-07-20T09:01:00.000Z"
const T3 = "2026-07-20T09:02:00.000Z"

beforeEach(() => {
  vi.clearAllMocks()
  addWorkItemComment.mockResolvedValue({ comment: comment("new", "x", T3) })
})

describe("replying", () => {
  const thread = () => [
    comment("root", "question", T1, { author: "mason" }),
    comment("r1", "answer", T2, { author: "build-lead", parentCommentId: "root" }),
  ]

  it("offers Reply on a reply and posts that reply's id as the parent", async () => {
    const user = userEvent.setup()
    renderThread(thread())

    await user.click(await screen.findByTestId("activity-reply-r1"))
    const row = screen.getByText(/Replying to/).parentElement as HTMLElement
    expect(row.textContent).toContain("Build Lead")

    await user.type(screen.getByTestId("composer-input"), "thanks")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledWith("PLA-12", "thanks", "r1"))
  })

  it("still replies to a top-level comment with that comment's id", async () => {
    const user = userEvent.setup()
    renderThread(thread())

    await user.click(await screen.findByTestId("activity-reply-root"))
    await user.type(screen.getByTestId("composer-input"), "again")
    await user.keyboard("{Enter}")
    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledWith("PLA-12", "again", "root"))
  })
})

describe("who a flattened reply answers", () => {
  const base = [
    comment("root", "question", T1, { author: "mason" }),
    comment("r1", "answer", T2, { author: "build-lead", parentCommentId: "root" }),
  ]

  it("names the comment actually answered when it is not the thread root", async () => {
    renderThread([
      ...base,
      comment("r2", "follow-up", T3, { author: "test-lead", parentCommentId: "root", repliedToId: "r1" }),
    ])
    const line = await screen.findByTestId("activity-replied-to-r2")
    expect(line.textContent).toContain("replying to")
    expect(line.textContent).toContain("Build Lead")
  })

  it("shows nothing when the reply answered the root itself", async () => {
    renderThread([
      ...base.slice(0, 1),
      comment("r1", "answer", T2, { parentCommentId: "root", repliedToId: "root" }),
    ])
    await screen.findByTestId("activity-comment-r1")
    expect(screen.queryByTestId("activity-replied-to-r1")).toBeNull()
  })

  it("shows nothing when the answered comment is not loaded", async () => {
    renderThread([
      ...base,
      comment("r2", "follow-up", T3, { parentCommentId: "root", repliedToId: "not-loaded" }),
    ])
    await screen.findByTestId("activity-comment-r2")
    expect(screen.queryByTestId("activity-replied-to-r2")).toBeNull()
  })

  it("shows nothing when the gateway recorded no target", async () => {
    renderThread([...base])
    await screen.findByTestId("activity-comment-r1")
    expect(screen.queryByTestId("activity-replied-to-r1")).toBeNull()
  })
})

describe("the @mention picker", () => {
  const input = () => screen.getByTestId("composer-input") as HTMLTextAreaElement

  it("lists matching employees, leaves system ones out, and matches display names", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "@t")

    const options = within(screen.getByTestId("mention-picker")).getAllByRole("option")
    expect(options.map((o) => o.getAttribute("data-testid"))).toEqual(["mention-option-test-lead"])

    await user.clear(input())
    await user.type(input(), "@")
    const all = within(screen.getByTestId("mention-picker")).getAllByRole("option")
    expect(all.map((o) => o.getAttribute("data-testid"))).not.toContain("mention-option-ops-bot")
    expect(all).toHaveLength(3)
  })

  it("inserts @name and a space on Enter, and does not submit", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "hello @bui")
    await user.keyboard("{Enter}")

    expect(input().value).toBe("hello @build-lead ")
    expect(addWorkItemComment).not.toHaveBeenCalled()
    expect(screen.queryByTestId("mention-picker")).toBeNull()

    // With the list closed, Enter submits as it always did.
    await user.keyboard("{Enter}")
    await waitFor(() => expect(addWorkItemComment).toHaveBeenCalledWith("PLA-12", "hello @build-lead", undefined))
  })

  it("moves the selection with the arrow keys and inserts on Tab", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "@")
    await user.keyboard("{ArrowDown}")
    const picked = within(screen.getByTestId("mention-picker"))
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true") as HTMLElement
    const name = picked.getAttribute("data-testid")!.replace("mention-option-", "")
    expect(name).not.toBe("")

    await user.keyboard("{Tab}")
    expect(input().value).toBe(`@${name} `)
    expect(addWorkItemComment).not.toHaveBeenCalled()
  })

  it("closes on Escape without inserting or submitting", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "@tes")
    expect(screen.getByTestId("mention-picker")).toBeTruthy()

    await user.keyboard("{Escape}")
    expect(screen.queryByTestId("mention-picker")).toBeNull()
    expect(input().value).toBe("@tes")
    expect(addWorkItemComment).not.toHaveBeenCalled()
  })

  it("inserts on click", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "cc @mas")
    fireEvent.mouseDown(screen.getByTestId("mention-option-mason"))
    expect(input().value).toBe("cc @mason ")
  })

  it("does not open for an @ inside an email address", async () => {
    const user = userEvent.setup()
    renderThread([])
    await user.type(await screen.findByTestId("composer-input"), "mail me@mas")
    expect(screen.queryByTestId("mention-picker")).toBeNull()
  })
})

describe("mention chips in a comment body", () => {
  it("chips a roster employee, with the handle as the title", async () => {
    renderThread([comment("c", "over to @build-lead, thanks", T1)])
    const chip = await screen.findByTestId("employee-mention")
    expect(chip.textContent).toBe("Build Lead")
    expect(chip.getAttribute("title")).toBe("@build-lead")
  })

  it("leaves unknown names, system employees, emails and code as plain text", async () => {
    renderThread([
      comment("c", "@nobody @ops-bot mail x@mason.com `@mason`\n\n```\n@mason\n```", T1),
    ])
    const row = await screen.findByTestId("activity-comment-c")
    await waitFor(() => expect(row.querySelector("pre")).not.toBeNull())
    expect(within(row).queryByTestId("employee-mention")).toBeNull()
    expect(row.textContent).toContain("@nobody")
    expect(row.textContent).toContain("@ops-bot")
  })

  it("matches case-insensitively", async () => {
    renderThread([comment("c", "@Test-Lead?", T1)])
    expect((await screen.findByTestId("employee-mention")).textContent).toBe("Test Lead")
  })
})
