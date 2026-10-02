import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { api } from "@/lib/api"
import { clearTalkActions, talkActions } from "../../talk-action-log"
import { answerSituation, dismissSituation } from "../../talk-situation-store"
import { pendingUndo } from "../../talk-undo-store"
import { executeToolCall } from "../registry"

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: {
    sendMessage: vi.fn(),
    addWorkItemComment: vi.fn(),
  },
}))

const mocked = vi.mocked(api)

/** Every situation-first tool, with a valid call and the client method it must
 *  not reach until an answer comes back. */
const ASKED: Array<{ tool: string; args: string; reaches: keyof typeof mocked }> = [
  { tool: "talk_send_to_session", args: '{"id":"s-1","message":"ship it"}', reaches: "sendMessage" },
  { tool: "jinn_action", args: '{"intent":"note that we shipped","subject":"ABC-59"}', reaches: "addWorkItemComment" },
]

beforeEach(() => {
  vi.clearAllMocks()
  clearTalkActions()
  mocked.sendMessage.mockResolvedValue({} as never)
  mocked.addWorkItemComment.mockResolvedValue({ comment: { id: "wic_1" } } as never)
})

afterEach(() => dismissSituation())

describe("nothing outward-facing happens before the operator answers", () => {
  it.each(ASKED)("$tool waits for the sheet rather than writing on the model's word", async ({ tool, args, reaches }) => {
    const pending = executeToolCall(tool, args)

    // The situation is up by now — `execute` runs as far as the ask before it
    // yields — and the gateway has not been touched.
    expect(mocked[reaches]).not.toHaveBeenCalled()
    answerSituation("go")
    const result = await pending

    expect(mocked[reaches]).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
  })

  it.each(ASKED)("$tool treats a dismissal as a refusal, not a failed write", async ({ tool, args, reaches }) => {
    const pending = executeToolCall(tool, args)

    dismissSituation()
    const result = await pending

    expect(mocked[reaches]).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("Refused")
    expect(result.error).toContain("Nothing was written")
  })

  it.each(ASKED)("$tool reads any answer that is not the affirmative card as a no", async ({ tool, args, reaches }) => {
    const pending = executeToolCall(tool, args)

    answerSituation("leave")
    const result = await pending

    expect(mocked[reaches]).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it.each(ASKED)("$tool offers no undo — consent is what stands in for one", async ({ tool, args }) => {
    const pending = executeToolCall(tool, args)
    answerSituation("go")
    const result = await pending

    if (!result.ok) throw new Error("expected success")
    expect(result.data.undo).toBeUndefined()
    expect(pendingUndo()).toBeNull()
  })
})

describe("the catch-all", () => {
  it("refuses outright when it has nowhere to record the ask, and asks for nothing", async () => {
    const result = await executeToolCall("jinn_action", '{"intent":"reorganise the board"}')

    expect(mocked.addWorkItemComment).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected a refusal")
    expect(result.error).toContain("was not one")
    // No consent was asked for, so none is logged: the log records attempted
    // writes, and this never became one.
    expect(talkActions()).toHaveLength(0)
  })

  it("records the operator's words against the Todo once they agree", async () => {
    const pending = executeToolCall("jinn_action", '{"intent":"chase the vendor","subject":"ABC-59","detail":"they went quiet"}')
    answerSituation("go")
    await pending

    expect(mocked.addWorkItemComment).toHaveBeenCalledWith("ABC-59", "chase the vendor\n\nthey went quiet", undefined, "talk")
  })
})

describe("the consent decision itself is logged", () => {
  it("records one entry per attempted write, saying which lane it took and how it was answered", async () => {
    const granted = executeToolCall("talk_send_to_session", '{"id":"s-1","message":"ship it"}')
    answerSituation("go")
    await granted

    const refused = executeToolCall("talk_send_to_session", '{"id":"s-2","message":"hold it"}')
    dismissSituation()
    await refused

    expect(talkActions().map((entry) => ({ tool: entry.tool, subject: entry.subject, lane: entry.lane, consent: entry.consent }))).toEqual([
      { tool: "talk_send_to_session", subject: "s-1", lane: "consent", consent: "granted" },
      { tool: "talk_send_to_session", subject: "s-2", lane: "consent", consent: "refused" },
    ])
  })
})
