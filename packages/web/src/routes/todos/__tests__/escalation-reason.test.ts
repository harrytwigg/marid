import { describe, expect, it } from "vitest"
import type { WorkItemCompactWire, WorkItemDetailWire, WorkItemFullWire, WorkItemOpenDetailWire } from "@/lib/api"
import { exceptionReasonOf } from "../task-page/banner"
import { reasonOf } from "../board/card"
import { event } from "./fixtures/task-wire"

/* ICI-730 added a second guard that escalates on its own (a Todo blocked again
 * and again for the same reason). Both why-lines read the escalation event's
 * `reason`, so an unmapped one renders blank exactly where the operator needs
 * to know why the work stopped. */

const escalation = (reason: string) =>
  event("e1", "escalated", "2026-08-13T08:00:00.000Z", {
    toStatus: "blocked",
    detail: { reason, blockKind: "dependency", recurrences: 2 },
  })

const detail = (reason: string): WorkItemDetailWire => ({
  workItem: { id: "PLA-12", status: "blocked" } as WorkItemFullWire,
  spendUsd: 0,
  events: [escalation(reason)],
})

describe("the escalation why-line", () => {
  it.each([
    ["block_loop_detected", "Blocked again for the same reason"],
    ["max-rounds-exhausted", "Review rounds exhausted"],
  ])("reads %s on the task-page banner and the board card", (reason, expected) => {
    expect(exceptionReasonOf(detail(reason))).toMatchObject({ note: expected })

    const item = { id: "PLA-12", status: "blocked" } as WorkItemCompactWire
    expect(reasonOf(item, { events: [escalation(reason)] } as WorkItemOpenDetailWire)).toBe(expected)
  })

  it("still prefers the blocker's own note when there is one", () => {
    const withNote: WorkItemDetailWire = {
      ...detail("block_loop_detected"),
      events: [
        event("e1", "escalated", "2026-08-13T08:00:00.000Z", {
          toStatus: "blocked",
          detail: { reason: "block_loop_detected", note: "the upstream API is still down" },
        }),
      ],
    }
    expect(exceptionReasonOf(withNote).note).toBe("the upstream API is still down")
  })

  it("reads a migrated escalation's reason from the move into escalated", () => {
    const migrated: WorkItemDetailWire = {
      ...detail("block_loop_detected"),
      events: [
        event("e1", "status_change", "2026-08-13T08:00:00.000Z", { toStatus: "escalated" as never, detail: { note: "which vendor?" } }),
        event("e2", "status_change", "2026-10-01T20:53:00.000Z", { fromStatus: "escalated" as never, toStatus: "blocked", actor: "migration", detail: { reason: "retired-status", declared: true } }),
      ],
    }
    expect(exceptionReasonOf(migrated).note).toBe("which vendor?")
    expect(reasonOf({ id: "PLA-12", status: "blocked" } as WorkItemCompactWire, { events: migrated.events } as WorkItemOpenDetailWire)).toBe("which vendor?")
  })
})
