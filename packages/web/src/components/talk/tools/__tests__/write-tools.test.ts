import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query-client"
import { clearTalkActions, talkActions } from "../../talk-action-log"
import { answerSituation, dismissSituation } from "../../talk-situation-store"
import { UNDO_WINDOW_MS, forgetUndo, pendingUndo, takeUndo } from "../../talk-undo-store"
import { executeToolCall } from "../registry"
import { FAST_LANE_TOOLS } from "../write-tools"

// Only the client is faked. The module's other exports stay real because the
// edit lane these tools reuse for unassignment is built on them.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    addWorkItemComment: vi.fn(),
    deleteWorkItemComment: vi.fn(),
    createWorkItem: vi.fn(),
    archiveWorkItem: vi.fn(),
    getWorkItem: vi.fn(),
    setWorkItemStatus: vi.fn(),
    assignWorkItem: vi.fn(),
    updateWorkItem: vi.fn(),
    setWorkItemLabels: vi.fn(),
  },
}))

const mocked = vi.mocked(api)

// `backlog` because the fast lane is per-edge: the board has no way back from
// `in_review` to `backlog`, so a move there asks, while `blocked` can be undone.
const TODO = {
  workItem: { id: "ABC-59", title: "Ship the orb", status: "backlog", assignee: "a-lead", department: "platform", version: 4 },
  labels: [{ id: "l1", name: "build" }],
  comments: { total: 1, comments: [{ id: "c1", author: "operator", createdAt: "2026-01-02T00:00:00Z", body: "first" }] },
}

/** Enough of each write's response for the tool to name what it did and how to
 *  put it back — the tools read nothing else from the wire. */
function stubEveryWrite() {
  mocked.getWorkItem.mockResolvedValue(TODO as never)
  mocked.addWorkItemComment.mockResolvedValue({ comment: { id: "wic_1" } } as never)
  mocked.createWorkItem.mockResolvedValue({ workItem: { id: "ABC-60", title: "New", status: "backlog", version: 1 } } as never)
  mocked.setWorkItemStatus.mockResolvedValue({ workItem: { id: "ABC-59", status: "blocked", version: 5 } } as never)
  mocked.assignWorkItem.mockResolvedValue({ workItem: { id: "ABC-59", assignee: "b-lead", status: "backlog", version: 5 } } as never)
  mocked.setWorkItemLabels.mockResolvedValue({ labels: [{ id: "l2", name: "shipped" }] } as never)
}

/** One valid call per fast-lane tool, so the lane can be checked as a whole
 *  rather than one tool at a time. */
const FAST_CALLS: Record<string, string> = {
  talk_comment_todo: '{"id":"ABC-59","body":"Looks right to me."}',
  talk_create_todo: '{"title":"Ship the orb"}',
  talk_set_todo_status: '{"id":"ABC-59","status":"blocked"}',
  talk_assign_todo: '{"id":"ABC-59","assignee":"b-lead"}',
  talk_label_todo: '{"id":"ABC-59","labels":"shipped"}',
}

/** Every call this suite's mocked client has taken, so a reversal can be shown
 *  to have reached the gateway without naming which route it used. */
function apiCalls(): number {
  return Object.values(mocked).reduce((total, fn) => total + fn.mock.calls.length, 0)
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  clearTalkActions()
  forgetUndo()
  stubEveryWrite()
})

afterEach(() => {
  forgetUndo()
  dismissSituation()
  vi.useRealTimers()
})

describe("commenting through the orb", () => {
  it("posts the comment, declares where it came from, and offers the way back", async () => {
    const result = await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    expect(mocked.addWorkItemComment).toHaveBeenCalledWith("ABC-59", "Looks right to me.", undefined, "talk")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data).toMatchObject({ performed: "Commented on ABC-59.", subject: "ABC-59", undo: "talk_undo" })
    expect(pendingUndo()?.performed).toBe("Commented on ABC-59.")
  })

  it("takes the comment back when the undo is taken inside the window", async () => {
    await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    const undone = await takeUndo()

    expect(undone.ok).toBe(true)
    expect(mocked.deleteWorkItemComment).toHaveBeenCalledWith("ABC-59", "wic_1", "talk")
    expect(pendingUndo()).toBeNull()
  })

  it("leaves the comment in place when the window lapses", async () => {
    vi.useFakeTimers()
    await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1)

    expect(pendingUndo()).toBeNull()
    expect(mocked.deleteWorkItemComment).not.toHaveBeenCalled()
  })

  it("drops the Todo the orb has cached, so its own next read is not the world before it spoke", async () => {
    queryClient.setQueryData(["work-item", "ABC-59"], TODO)

    await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    expect(queryClient.getQueryData(["work-item", "ABC-59"])).toBeUndefined()
  })
})

describe("the fast lane's one rule", () => {
  it.each(FAST_LANE_TOOLS.map((tool) => tool.name))(
    "%s cannot succeed without leaving a reversal on the table",
    async (name) => {
      const result = await executeToolCall(name, FAST_CALLS[name])

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("expected success")
      expect(result.data.undo).toBe("talk_undo")
      expect(pendingUndo()).not.toBeNull()
      // "Working" means it runs, not that it exists: taking it has to reach the
      // gateway, or the button is decoration.
      const before = apiCalls()
      expect(await takeUndo()).toMatchObject({ ok: true })
      expect(apiCalls()).toBeGreaterThan(before)
    },
  )

  it("puts an unassigned Todo back where it was — nobody assigned, no department, and its status untouched", async () => {
    // Assigning writes the new employee's department onto the Todo as well as
    // their name, so clearing only the name leaves theirs behind on a Todo
    // nobody is assigned to.
    mocked.getWorkItem
      .mockResolvedValueOnce({ ...TODO, workItem: { ...TODO.workItem, assignee: null, department: null, status: "backlog" } } as never)
      .mockResolvedValueOnce({ ...TODO, workItem: { ...TODO.workItem, assignee: "b-lead", department: "growth", version: 5 } } as never)
    await executeToolCall("talk_assign_todo", FAST_CALLS.talk_assign_todo)

    await takeUndo()

    // The assign route takes the department from the employee it names, so it
    // cannot put an arbitrary one back: all of it goes through the edit lane.
    expect(mocked.updateWorkItem).toHaveBeenCalledWith("ABC-59", expect.objectContaining({
      patch: { assignee: null, department: null },
      expectedVersion: 5,
    }))
    // Assigning does not move the Todo, so there is no status to put back.
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("restores the department the Todo held, not the one its new assignee brought, and moves nothing already assigned", async () => {
    mocked.getWorkItem
      .mockResolvedValueOnce(TODO as never)
      .mockResolvedValueOnce({ ...TODO, workItem: { ...TODO.workItem, assignee: "b-lead", department: "growth", version: 5 } } as never)
    await executeToolCall("talk_assign_todo", FAST_CALLS.talk_assign_todo)

    await takeUndo()

    expect(mocked.updateWorkItem).toHaveBeenCalledWith("ABC-59", expect.objectContaining({
      patch: { assignee: "a-lead", department: "platform" },
      expectedVersion: 5,
    }))
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("fences the reversal on the revision it reads back, not the one it saw before the assign", async () => {
    mocked.getWorkItem
      .mockResolvedValueOnce({ ...TODO, workItem: { ...TODO.workItem, assignee: null, department: null, status: "backlog" } } as never)
      .mockResolvedValueOnce({ ...TODO, workItem: { ...TODO.workItem, assignee: "b-lead", department: "growth", version: 9 } } as never)
    mocked.updateWorkItem.mockImplementation(async (_id, request) => {
      if (request.expectedVersion !== 9) throw new Error("Todo changed since it was loaded.")
      return { workItem: { ...TODO.workItem, version: 10 }, replayed: false } as never
    })

    await executeToolCall("talk_assign_todo", FAST_CALLS.talk_assign_todo)

    // The assign bumps the revision the tool read a moment earlier, and anything
    // else may have bumped it since; a reversal fenced on either would 409.
    expect(await takeUndo()).toMatchObject({ ok: true })
  })

  it("reports a write the gateway refused as a failure, offers nothing to undo, and still logs the attempt", async () => {
    mocked.addWorkItemComment.mockRejectedValue(new Error("Todo ABC-59 does not exist"))

    const result = await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    expect(result).toEqual({ ok: false, error: "Could not comment on ABC-59: Todo ABC-59 does not exist." })
    expect(pendingUndo()).toBeNull()
    expect(talkActions()).toEqual([
      expect.objectContaining({ tool: "talk_comment_todo", subject: "ABC-59", lane: "fast", consent: "not-required" }),
    ])
  })
})

describe("a status move the board cannot take back", () => {
  it("asks first rather than offering an undo the ledger would refuse", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"in_review"}')
    await vi.waitFor(() => expect(mocked.getWorkItem).toHaveBeenCalled())

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBeUndefined()
    expect(pendingUndo()).toBeNull()
  })

  it("writes nothing when the operator waves it off", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"in_review"}')
    await vi.waitFor(() => expect(mocked.getWorkItem).toHaveBeenCalled())
    dismissSituation()

    expect(await pending).toMatchObject({ ok: false })
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
  })
})

describe("cancelling is not a board gesture", () => {
  it("asks before it closes the work, and writes nothing if the operator says no", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"cancelled"}')

    // The sheet is up and nothing has been written: `execute` runs as far as the
    // ask before it yields, so this is the state the operator is looking at.
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    dismissSituation()
    const result = await pending

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(pendingUndo()).toBeNull()
  })

  it("cancels once the operator agrees, and does not pretend it can be taken back", async () => {
    mocked.setWorkItemStatus.mockResolvedValue({ workItem: { id: "ABC-59", status: "cancelled" } } as never)
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"cancelled"}')

    answerSituation("go")
    const result = await pending

    expect(mocked.setWorkItemStatus).toHaveBeenCalledWith("ABC-59", "cancelled", undefined, "talk")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBeUndefined()
    expect(pendingUndo()).toBeNull()
  })
})

describe("the action log", () => {
  it("records the fast-lane write and, separately, the reversal that undid it", async () => {
    await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)
    await takeUndo()

    expect(talkActions().map((entry) => ({ tool: entry.tool, lane: entry.lane, consent: entry.consent }))).toEqual([
      { tool: "talk_comment_todo", lane: "fast", consent: "not-required" },
      { tool: "talk_undo", lane: "fast", consent: "not-required" },
    ])
  })

  it("records a reversal the gateway refused, which is the attempt most worth finding later", async () => {
    mocked.deleteWorkItemComment.mockRejectedValue(new Error("comment wic_1 not found"))
    await executeToolCall("talk_comment_todo", FAST_CALLS.talk_comment_todo)

    expect(await executeToolCall("talk_undo", "{}")).toMatchObject({ ok: false })

    expect(talkActions().map((entry) => entry.tool)).toEqual(["talk_comment_todo", "talk_undo"])
  })

  it("records an undo with nothing on the table — the model asked for a write either way", async () => {
    expect(await executeToolCall("talk_undo", "{}")).toMatchObject({ ok: false })

    expect(talkActions()).toEqual([
      expect.objectContaining({ tool: "talk_undo", subject: null, lane: "fast", consent: "not-required" }),
    ])
  })

  it("records the refusal too — a write nobody agreed to is still a decision that was made", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"cancelled"}')
    dismissSituation()
    await pending

    expect(talkActions()).toHaveLength(1)
    expect(talkActions()[0]).toMatchObject({
      tool: "talk_set_todo_status",
      subject: "ABC-59",
      lane: "consent",
      consent: "refused",
    })
  })
})
