import { describe, expect, it } from "vitest"
import { hasOnlyWaitingWorkers } from "../task-page/use-todo-sessions"

/* The status chip's elapsed time says "Working" while anything is working and
 * "Waiting" only when the work in flight is paused. A consulted session is
 * answering a question, not working the Todo, so it never decides this. */

const s = (id: string, over: Partial<{ employee: string; status: string; workItemRole: string }> = {}) =>
  ({ id, employee: null, status: "idle", ...over }) as never

describe("hasOnlyWaitingWorkers", () => {
  it("is true when the only live worker is paused", () => {
    expect(hasOnlyWaitingWorkers([s("a", { status: "waiting" })])).toBe(true)
  })

  it("is false while any worker is still running", () => {
    expect(hasOnlyWaitingWorkers([s("a", { status: "waiting" }), s("b", { status: "running" })])).toBe(false)
  })

  it("ignores a consulted session either way", () => {
    expect(
      hasOnlyWaitingWorkers([s("a", { status: "waiting" }), s("consult", { status: "running", workItemRole: "consult" })]),
    ).toBe(true)
  })

  it("is false when nothing is live, or nothing is linked", () => {
    expect(hasOnlyWaitingWorkers([s("a", { status: "idle" })])).toBe(false)
    expect(hasOnlyWaitingWorkers([])).toBe(false)
  })
})
