import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { legalTargets } from "@/lib/legal-targets"
import { clearTalkActions, talkActions } from "../../talk-action-log"
import { answerSituation, currentSituation, dismissSituation } from "../../talk-situation-store"
import { pendingUndo } from "../../talk-undo-store"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    getWorkItem: vi.fn(),
    getWorkItemTree: vi.fn(),
    decideWorkItemApproval: vi.fn(),
    setWorkItemStatus: vi.fn(),
  },
}))

const mocked = vi.mocked(api)

const GATE = {
  workItem: {
    id: "ABC-59",
    title: "Ship the orb",
    status: "in_review",
    approvalState: "pending",
    approvalRequest: "Land the branch on main?",
  },
}

function todo(workItem: Record<string, unknown>) {
  return { workItem: { ...GATE.workItem, ...workItem } } as never
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
  mocked.decideWorkItemApproval.mockResolvedValue({ workItem: GATE.workItem, escalated: false } as never)
  mocked.setWorkItemStatus.mockResolvedValue({ workItem: { id: "ABC-59", status: "assigned" } } as never)
})

afterEach(() => dismissSituation())

describe("deciding a Todo's approval", () => {
  it("quotes what was asked, then sends the decision the operator agreed to", async () => {
    const pending = executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"approve","note":"reviewed it myself","choice":"Variant B"}')
    const asked = await sheet()

    expect(`${asked.title} ${asked.hint ?? ""}`).toContain("Land the branch on main?")
    expect(mocked.decideWorkItemApproval).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(mocked.decideWorkItemApproval).toHaveBeenCalledWith("ABC-59", "approve", "reviewed it myself", "Variant B")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    // Consent is what stands in for the undo: an approval that has been acted on
    // downstream cannot be taken back by this browser.
    expect(result.data.undo).toBeUndefined()
    expect(pendingUndo()).toBeNull()
  })

  it("decides nothing when the operator waves it off", async () => {
    const pending = executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"reject"}')
    await sheet()
    dismissSituation()
    const result = await pending

    expect(mocked.decideWorkItemApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false })
  })

  it("refuses a Todo with no gate waiting, without asking anybody", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ approvalState: "approved", approvalRequest: "Land the branch on main?" }))

    const result = await executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"approve"}')

    expect(currentSituation()).toBeNull()
    expect(mocked.decideWorkItemApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("nothing waiting") })
    // Never became a write, so there is nothing for the log to show.
    expect(talkActions()).toHaveLength(0)
  })

  it("refuses to approve a pick without naming which one, rather than guessing", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ approvalOptions: ["Variant A", "Variant B"] }))

    const result = await executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"approve"}')

    expect(currentSituation()).toBeNull()
    expect(mocked.decideWorkItemApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("asks which one, not whether") })
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("Variant A")
  })

  it("refuses a pick the gate does not offer — a misheard option is not a vote", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ approvalOptions: ["Variant A", "Variant B"] }))

    const result = await executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"approve","choice":"Variant 8"}')

    expect(mocked.decideWorkItemApproval).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Variant 8") })
  })

  it("lets a rejection through an option gate — sending it back picks nothing", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ approvalOptions: ["Variant A", "Variant B"] }))
    const pending = executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"reject","note":"neither"}')
    await sheet()
    answerSituation("go")

    expect(await pending).toMatchObject({ ok: true })
    expect(mocked.decideWorkItemApproval).toHaveBeenCalledWith("ABC-59", "reject", "neither", undefined)
  })
})

describe("unblocking a Todo", () => {
  const BLOCKED = '{"id":"ABC-59","status":"assigned","note":"the vendor answered"}'

  it("moves it with the note attached once the operator agrees", async () => {
    mocked.getWorkItem.mockResolvedValue(todo({ status: "blocked" }))
    const pending = executeToolCall("talk_unblock_todo", BLOCKED)
    await sheet()

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(mocked.setWorkItemStatus).toHaveBeenCalledWith("ABC-59", "assigned", "the vendor answered", "talk")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBeUndefined()
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
      tree: { root: { id: "ABC-59", children: [{ id: "ABC-60", status: "executing" }, { id: "ABC-61", status: "assigned" }] } },
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

    const result = await executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"executing","note":"back on it"}')

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
    const granted = executeToolCall("talk_unblock_todo", '{"id":"ABC-59","status":"assigned","note":"unstuck"}')
    await sheet()
    answerSituation("go")
    await granted

    const refused = executeToolCall("talk_decide_approval", '{"id":"ABC-59","decision":"reject"}')
    await sheet()
    dismissSituation()
    await refused

    expect(talkActions().map((entry) => ({ tool: entry.tool, subject: entry.subject, lane: entry.lane, consent: entry.consent }))).toEqual([
      { tool: "talk_unblock_todo", subject: "ABC-59", lane: "consent", consent: "granted" },
      { tool: "talk_decide_approval", subject: "ABC-59", lane: "consent", consent: "refused" },
    ])
  })
})
