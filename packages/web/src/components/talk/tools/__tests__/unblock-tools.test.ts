import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { clearTalkActions, talkActions } from "../../talk-action-log"
import { answerSituation, currentSituation, dismissSituation } from "../../talk-situation-store"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    getWorkItem: vi.fn(),
    getWorkItemTree: vi.fn(),
    setWorkItemStatus: vi.fn(),
  },
}))

const mocked = vi.mocked(api)

const BASE = {
  workItem: {
    id: "ABC-59",
    title: "Ship the orb",
    status: "in_review",
  },
}

function todo(workItem: Record<string, unknown>) {
  return { workItem: { ...BASE.workItem, ...workItem } } as never
}

/** The sheet is raised behind a read, so a test cannot answer it on the same
 *  tick the call was made. */
async function sheet() {
  await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
  return currentSituation()!
}

beforeEach(() => {
  vi.clearAllMocks()
  clearTalkActions()
  mocked.getWorkItem.mockResolvedValue(todo({}))
  mocked.getWorkItemTree.mockResolvedValue({ tree: { root: { id: "ABC-59", children: [] } } } as never)
  mocked.setWorkItemStatus.mockResolvedValue({ workItem: { id: "ABC-59", status: "backlog" } } as never)
})

afterEach(() => dismissSituation())

describe("unblocking a Todo", () => {
  const BLOCKED = '{"id":"ABC-59","status":"backlog","note":"the vendor answered"}'

  it("moves it with the note attached once the operator agrees", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    const pending = executeToolCall("talk_unblock_todo", BLOCKED)
    await sheet()

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(mocked.setWorkItemStatus).toHaveBeenCalledWith("ABC-59", "backlog", "the vendor answered", "talk")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBeUndefined()
  })

  it("offers executing as a target now that the operator may resume blocked work", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    const pending = executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"executing","note":"back on it"}')
    await sheet()
    answerSituation("go")
    const result = await pending

    expect(mocked.setWorkItemStatus).toHaveBeenCalledWith("ABC-59", "executing", "back on it", "talk")
    expect(result.ok).toBe(true)
  })

  it("refuses a Todo that is not blocked", async () => {
    const result = await executeToolCall("talk_unblock_todo", BLOCKED)

    expect(currentSituation()).toBeNull()
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("in_review") })
  })

  it("refuses a close the board's gate would refuse, and says how many sub-tasks are open", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    mocked.getWorkItemTree.mockResolvedValue({
      tree: { root: { id: "ABC-59", children: [{ id: "ABC-60", status: "executing" }, { id: "ABC-61", status: "done" }] } },
    } as never)

    const result = await executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"done","note":"finished"}')

    expect(currentSituation()).toBeNull()
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("1 sub-task") })
  })

  it("will not cascade a close by voice, however many sub-tasks it would take", async () => {
    // The premise, guarded so this cannot pass vacuously: the BOARD offers this
    // close live, as a cascade. The refusal below therefore has to be the tool's
    // own — reading only `gated` is what let the voice surface pick the cascade
    // up without ever deciding to.
    expect(legalTargets("blocked", { openChildren: 2 })).toContainEqual(
      expect.objectContaining({ status: "done", gated: false, cascade: true }),
    )
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    mocked.getWorkItemTree.mockResolvedValue({
      tree: { root: { id: "ABC-59", children: [{ id: "ABC-60", status: "executing" }, { id: "ABC-61", status: "backlog" }] } },
    } as never)

    const result = await executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"done","note":"finished"}')

    expect(currentSituation()).toBeNull()
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("2 sub-tasks") })
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("on the board")
  })

  it("refuses a target the board does not offer out of blocked", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))

    const result = await executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"blocked","note":"back on it"}')

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false })
  })

  it("reports a failed sub-task read rather than counting it as none open", async () => {
    // Defaulting to zero would offer a close the gateway is about to refuse and
    // blame the move for a read that never landed.
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    mocked.getWorkItemTree.mockRejectedValue(new Error("the gateway did not answer"))

    const result = await executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"done","note":"finished"}')

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("sub-tasks") })
  })
})

describe("the action log", () => {
  it("records one entry per attempt, in the consent lane, with how it was answered", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    const granted = executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"backlog","note":"unstuck"}')
    await sheet()
    answerSituation("go")
    await granted

    const refused = executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"backlog","note":"unstuck"}')
    await sheet()
    dismissSituation()
    await refused

    expect(talkActions().map((entry) => ({ tool: entry.tool, subject: entry.subject, lane: entry.lane, consent: entry.consent }))).toEqual([
      { tool: "talk_unblock_todo", subject: "ABC-59", lane: "consent", consent: "granted" },
      { tool: "talk_unblock_todo", subject: "ABC-59", lane: "consent", consent: "refused" },
    ])
  })
})
