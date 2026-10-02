import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { answerSituation, currentSituation, dismissSituation } from "../../talk-situation-store"
import { forgetUndo, pendingUndo } from "../../talk-undo-store"
import { executeToolCall } from "../registry"

/**
 * `talk_set_todo_status` leaving `blocked`.
 *
 * Apart from the rest of the write lane's suite because it is the one move whose
 * lane the edge map gets wrong: `blocked → backlog` is reversible, so the fast
 * lane would take "move it to backlog" on the model's word — and that sentence
 * is an unblock, which releases the work to whoever picks it up.
 */

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { getWorkItem: vi.fn(), setWorkItemStatus: vi.fn() },
}))

const mocked = vi.mocked(api)

beforeEach(() => {
  vi.clearAllMocks()
  forgetUndo()
  mocked.getWorkItem.mockResolvedValue({ workItem: { id: "ABC-59", status: "blocked", version: 4 } } as never)
  mocked.setWorkItemStatus.mockResolvedValue({ workItem: { id: "ABC-59", status: "backlog" } } as never)
})

afterEach(() => {
  forgetUndo()
  dismissSituation()
})

describe("leaving blocked is an unblock, whatever the edge map says", () => {
  it("asks even though the board would take the move back", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"backlog"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())

    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(mocked.setWorkItemStatus).toHaveBeenCalledWith("ABC-59", "backlog", undefined, "talk")
    if (!result.ok) throw new Error("expected success")
    // No undo: a fifteen-second window does not reach the agent that started.
    expect(result.data.undo).toBeUndefined()
    expect(pendingUndo()).toBeNull()
  })

  it("writes nothing when the operator waves the unblock off", async () => {
    const pending = executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"backlog"}')
    await vi.waitFor(() => expect(currentSituation()).not.toBeNull())
    dismissSituation()

    expect(await pending).toMatchObject({ ok: false })
    expect(mocked.setWorkItemStatus).not.toHaveBeenCalled()
  })

  it("still takes the fast lane for a reversible move that is not out of blocked", async () => {
    mocked.getWorkItem.mockResolvedValue({ workItem: { id: "ABC-59", status: "backlog", version: 4 } } as never)

    const result = await executeToolCall("talk_set_todo_status", '{"id":"ABC-59","status":"blocked"}')

    expect(currentSituation()).toBeNull()
    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBe("talk_undo")
  })
})
