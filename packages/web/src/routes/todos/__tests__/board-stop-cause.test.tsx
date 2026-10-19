import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire } from "@/lib/api"
import { BoardCard, cardLayoutKey } from "../board/card"
import { stopCauseQuote } from "../needs-you-support"

/* A clock-wait and a you-wait used to render identically, under the
 * title, and hidden below 700px. These pin the two things that fixes: a
 * countdown that is honest about the clock, and a hint that leads the card. */

const HOUR = 3_600_000

function compact(over: Partial<WorkItemCompactWire> & { id: string; status: WorkItemStatusWire }): WorkItemCompactWire {
  return {
    version: 3,
    title: `Item ${over.id}`,
    assignee: null,
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: over.id,
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-08-21T08:00:00.000Z",
    rank: null,
    ...over,
  }
}

function renderCard(item: WorkItemCompactWire) {
  return render(
    <BoardCard
      item={item}
      byName={new Map()}
      expanded={false}
      onToggleTree={() => {}}
      onOpen={() => {}}
      onOpenChild={() => {}}
      onAddSubTask={() => {}}
    />,
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe("a parked card counts down", () => {
  it("names the time left while the park is still ahead", () => {
    renderCard(compact({ id: "TSK-1", status: "blocked", parkedUntil: new Date(Date.now() + 2 * HOUR + 14 * 60_000).toISOString() }))
    expect(screen.getByTestId("park-chip-TSK-1").textContent).toContain("2h 14m")
  })

  it("shows minutes alone under an hour", () => {
    renderCard(compact({ id: "TSK-2", status: "blocked", parkedUntil: new Date(Date.now() + 45 * 60_000).toISOString() }))
    expect(screen.getByTestId("park-chip-TSK-2").textContent).toContain("45m")
  })

  it.each([
    ["one that has passed", new Date(Date.now() - HOUR).toISOString()],
    ["one that will not parse", "when the quota resets"],
  ])("shows no chip for %s", (_label, parkedUntil) => {
    renderCard(compact({ id: "TSK-3", status: "blocked", parkedUntil }))
    expect(screen.queryByTestId("park-chip-TSK-3")).toBeNull()
  })

  it("shows no chip when the Todo was never parked", () => {
    renderCard(compact({ id: "TSK-4", status: "blocked" }))
    expect(screen.queryByTestId("park-chip-TSK-4")).toBeNull()
  })

  it("drops the chip on its own once the park runs out, without a refetch", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderCard(compact({ id: "TSK-5", status: "blocked", parkedUntil: new Date(Date.now() + 60_000).toISOString() }))
    expect(screen.getByTestId("park-chip-TSK-5")).toBeTruthy()

    // One flush per hop: the timer re-arms from the effect that the state update
    // it made schedules, which is one render later.
    act(() => { vi.advanceTimersByTime(30_000) })
    act(() => { vi.advanceTimersByTime(31_000) })
    expect(screen.queryByTestId("park-chip-TSK-5")).toBeNull()
  })

  it("wakes at the expiry itself, not on a fixed cadence — a short park does not outlive its second", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderCard(compact({ id: "TSK-12", status: "blocked", parkedUntil: new Date(Date.now() + 5_000).toISOString() }))
    expect(screen.getByTestId("park-chip-TSK-12")).toBeTruthy()

    act(() => { vi.advanceTimersByTime(6_000) })
    expect(screen.queryByTestId("park-chip-TSK-12")).toBeNull()
  })
})

describe("a blocked card leads with the hint", () => {
  const stopped = compact({
    id: "TSK-6",
    status: "blocked",
    title: "Renew the provider contract",
    unblockHint: { what: "sign the renewal", who: "the operator" },
  })

  it("says what and who", () => {
    renderCard(stopped)
    const lead = screen.getByTestId("stop-lead-TSK-6")
    expect(lead.textContent).toContain("sign the renewal")
    expect(lead.textContent).toContain("the operator")
  })

  it("puts them above the title in the card's own reading order", () => {
    renderCard(stopped)
    const card = screen.getByTestId("board-card-TSK-6")
    const lead = screen.getByTestId("stop-lead-TSK-6")
    const title = [...card.querySelectorAll("div")].find((el) => el.textContent === "Renew the provider contract")!
    expect(lead.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("is not hidden on the phone, unlike the trailing why-line it replaces", () => {
    renderCard(stopped)
    expect(screen.getByTestId("stop-lead-TSK-6").className).not.toContain("max-[700px]:hidden")
  })

  it("gives who its own line, so a narrow column cannot truncate it away", () => {
    renderCard(stopped)
    const lines = [...screen.getByTestId("stop-lead-TSK-6").querySelectorAll("span")]
      .filter((el) => el.className.includes("truncate"))
      .map((el) => el.textContent)
    expect(lines).toContain("sign the renewal")
    expect(lines).toContain("the operator")
  })
})

describe("the column's FLIP key", () => {
  const key = (over: Partial<WorkItemCompactWire>) => cardLayoutKey(compact({ id: "TSK-7", status: "blocked", ...over }), undefined)

  const hint = { what: "decide", who: "the operator" }
  const parkedUntil = new Date(Date.now() + HOUR).toISOString()

  it("changes when a lead appears, so cards below it are cushioned", () => {
    expect(key({})).not.toBe(key({ unblockHint: hint }))
    expect(key({})).not.toBe(key({ parkedUntil }))
  })

  it("tells a chip apart from a chip AND a hint — they are different heights", () => {
    expect(key({ parkedUntil })).not.toBe(key({ parkedUntil, unblockHint: hint }))
    expect(key({ unblockHint: hint })).not.toBe(key({ parkedUntil, unblockHint: hint }))
    expect(key({ parkedUntil })).not.toBe(key({ unblockHint: hint }))
  })

  it("does not change as the countdown ticks — the key would churn every minute", () => {
    expect(key({ parkedUntil })).toBe(key({ parkedUntil }))
  })
})

describe("the Needs-you inbox speaks in the stop's own voice", () => {
  const NOW = Date.parse("2026-08-21T12:00:00.000Z")

  it("quotes the hint when there is one", () => {
    const item = compact({ id: "TSK-8", status: "blocked", unblockHint: { what: "sign the renewal", who: "the operator" } })
    expect(stopCauseQuote(item, NOW)).toBe("sign the renewal — the operator")
  })

  it("says a park is a clock-wait, instead of blaming the reader for it", () => {
    const item = compact({ id: "TSK-9", status: "blocked", parkedUntil: new Date(NOW + 90 * 60_000).toISOString() })
    expect(stopCauseQuote(item, NOW)).toBe("Waiting on a clock, not on you — back in 1h 30m.")
  })

  it("says nothing when the stop carries neither, leaving the caller's own copy", () => {
    expect(stopCauseQuote(compact({ id: "TSK-10", status: "blocked" }), NOW)).toBeNull()
    expect(stopCauseQuote(compact({ id: "TSK-11", status: "blocked", parkedUntil: new Date(NOW - 60_000).toISOString() }), NOW)).toBeNull()
  })
})
