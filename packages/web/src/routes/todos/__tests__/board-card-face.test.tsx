import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire, WorkItemStatusWire, WorkItemTreeWire } from "@/lib/api"
import { BoardCard, cardLayoutKey } from "../board/card"

/* ICI-1427 — the four-row face. Every card is the same four rows in the same
 * order, so what these pin is as much what is absent as what is present: a card
 * that grows a fifth row when enrichment lands is the bug this face fixes. */

vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} />,
}))

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

function tree(id: string, over: Partial<WorkItemTreeWire> = {}): WorkItemTreeWire {
  return {
    root: {
      id,
      version: 3,
      title: `Item ${id}`,
      body: "A body the Variant A face does not show.",
      status: "backlog",
      department: "platform",
      assignee: null,
      priority: 2,
      rank: null,
      source: "human",
      sourceRef: null,

      rounds: 0,
      budgetUsd: null,
      createdAt: "2026-08-21T08:00:00.000Z",
      updatedAt: "2026-08-21T08:00:00.000Z",
      closedAt: null,
      children: [],
    },
    totals: { backlog: 1 },
    spendUsd: 0,
    ...over,
  }
}

type CardOverrides = Partial<React.ComponentProps<typeof BoardCard>>

function renderCard(item: WorkItemCompactWire, over: CardOverrides = {}) {
  const view = render(
    <BoardCard
      item={item}
      byName={new Map()}
      expanded={false}
      onToggleTree={() => {}}
      onOpen={() => {}}
      onOpenChild={() => {}}
      onAddSubTask={() => {}}
      {...over}
    />,
  )
  return { ...view, card: screen.getByTestId(`board-card-${item.id}`) }
}

function rowsOf(card: HTMLElement): HTMLElement[] {
  return [...card.children] as HTMLElement[]
}

describe("the four rows, in order", () => {
  const item = compact({
    id: "PLA-1",
    status: "executing",
    title: "Ship the parser",
    assignee: "scout",
    dueAt: "2026-08-29T00:00:00.000Z",
    labels: [{ id: "lbl_1", name: "infra", color: "#5B9BD5", department: null, createdAt: "2026-08-01" }],
  })
  const enrichment = { tree: tree("PLA-1", { totals: { executing: 2, done: 1 }, spendUsd: 4.2 }) }

  it("renders exactly four rows: id + assignee, glyph + title, priority + labels + roll-up, cost + due", () => {
    const { card } = renderCard(item, { enrichment })
    const rows = rowsOf(card)
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toBe("PLA-1")
    expect(rows[0].querySelector('[data-testid="avatar-scout"]')).toBeTruthy()
    expect(rows[1].textContent).toBe("Ship the parser")
    expect(rows[2].textContent).toBe("infra1/2")
    expect(rows[2].querySelector('[data-testid="prio-bars"]')).toBeTruthy()
    expect(rows[3].textContent).toBe("$4.20Aug 29")
  })

  it("carries exactly one assignee avatar, in row 1", () => {
    const { card } = renderCard(item, { enrichment })
    expect(card.querySelectorAll('[data-testid^="avatar-"]')).toHaveLength(1)
    expect(rowsOf(card)[0].querySelectorAll('[data-testid^="avatar-"]')).toHaveLength(1)
  })

  it("shows no body excerpt, no kept caption, no cause line, no working line", () => {
    const card0 = compact({
      ...item,
      id: "PLA-2",
      kept: true,
      sessionRef: { ref: "session:abc", sessionId: "abc" },
    })
    const { card } = renderCard(card0, { enrichment: { tree: tree("PLA-2") } })
    expect(rowsOf(card)).toHaveLength(4)
    expect(card.textContent).not.toContain("A body the Variant A face does not show")
    expect(card.textContent).not.toContain("Working")
    expect(card.textContent).not.toContain("Kept")
    expect(screen.queryByTestId("kept-caption-PLA-2")).toBeNull()
  })
})

describe("one height for one title, whatever enrichment brings", () => {
  it("keeps four rows before enrichment arrives at all", () => {
    const { card } = renderCard(compact({ id: "PLA-3", status: "backlog" }))
    expect(rowsOf(card)).toHaveLength(4)
  })

  it("renders the cost row at $0.00 rather than dropping it", () => {
    const { card } = renderCard(compact({ id: "PLA-4", status: "backlog" }), { enrichment: { tree: tree("PLA-4") } })
    expect(rowsOf(card)[3].textContent).toBe("$0.00")
  })

  it("renders priority bars at Medium, which desktop cards used to hide", () => {
    const { card } = renderCard(compact({ id: "PLA-5", status: "backlog" }), { enrichment: { tree: tree("PLA-5") } })
    const bars = rowsOf(card)[2].querySelector('[data-testid="prio-bars"]')
    expect(bars?.getAttribute("data-priority")).toBe("2")
  })

  it("still occupies row 3 with no labels and no roll-up", () => {
    const { card } = renderCard(compact({ id: "PLA-6", status: "backlog" }))
    const row = rowsOf(card)[2]
    expect(row.textContent).toBe("")
    expect(row.className).toContain("h-5")
    expect(row.querySelector('[data-testid="prio-bars"]')).toBeTruthy()
  })

  it("cannot let enrichment move the column: the layout key ignores it", () => {
    const item = compact({ id: "PLA-7", status: "blocked", unblockHint: { what: "decide", who: "the operator" } })
    const rich = { tree: tree("PLA-7", { totals: { blocked: 3, done: 2 }, spendUsd: 91.5 }) }
    expect(cardLayoutKey(item, rich)).toBe(cardLayoutKey(item, undefined))
    expect(cardLayoutKey(item, undefined)).toBe(cardLayoutKey(item, { tree: tree("PLA-7") }))
  })
})

describe("the card's insets", () => {
  it("pads equally on all four sides", () => {
    const { card } = renderCard(compact({ id: "PLA-8", status: "backlog" }))
    const padding = card.className.split(/\s+/).filter((cls) => /(^|:)p[trblxy]?-/.test(cls))
    expect(padding).toEqual(["p-3"])
  })
})

describe("keep, on hover alone", () => {
  const item = compact({ id: "PLA-9", status: "backlog", kept: false })

  it("is hover-gated at rest, from the card's own group", () => {
    const { card } = renderCard(item, { onKeep: () => {} })
    const toggle = screen.getByTestId("keep-toggle-PLA-9")
    expect(card.className).toContain("group ")
    expect(toggle.className).toContain("opacity-0")
    expect(toggle.className).toContain("group-hover:opacity-100")
    expect(toggle.className).toContain("group-focus-within:opacity-100")
  })

  it("still toggles the keep when the pointer has revealed it", () => {
    const onKeep = vi.fn()
    renderCard(item, { onKeep })
    fireEvent.click(screen.getByTestId("keep-toggle-PLA-9"))
    expect(onKeep).toHaveBeenCalledWith({ id: "PLA-9", kept: true })
  })

  it("takes the keep off a card that is already kept", () => {
    const onKeep = vi.fn()
    renderCard(compact({ id: "PLA-10", status: "backlog", kept: true }), { onKeep })
    fireEvent.click(screen.getByTestId("keep-toggle-PLA-10"))
    expect(onKeep).toHaveBeenCalledWith({ id: "PLA-10", kept: false })
  })

  it("renders no toggle at all where the board passes no keep", () => {
    renderCard(compact({ id: "PLA-11", status: "backlog" }))
    expect(screen.queryByTestId("keep-toggle-PLA-11")).toBeNull()
  })
})

describe("the roll-up chip, from row 3", () => {
  const item = compact({ id: "PLA-12", status: "executing" })
  const enrichment = { tree: tree("PLA-12", { totals: { executing: 2, done: 1 }, spendUsd: 0 }) }

  it("toggles the tray without opening the card underneath it", () => {
    const onToggleTree = vi.fn()
    const onOpen = vi.fn()
    const { card } = renderCard(item, { enrichment, onToggleTree, onOpen })
    const chip = screen.getByTestId("board-rollup-PLA-12")
    expect(rowsOf(card)[2].contains(chip)).toBe(true)
    expect(chip.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(chip)
    expect(onToggleTree).toHaveBeenCalledWith("PLA-12")
    expect(onOpen).not.toHaveBeenCalled()
  })

  it("keeps its own width when a crowded row of labels has to give it back", () => {
    // Three labels in a 240px column used to push the chip past the row's
    // clipped edge: present in the DOM, zero pixels wide, impossible to click.
    const crowded = compact({
      ...item,
      labels: ["alpha", "beta", "gamma"].map((name, i) => (
        { id: `lbl_${i}`, name, color: null, department: null, createdAt: "2026-08-01" }
      )),
    })
    const { card } = renderCard(crowded, { enrichment })
    const chips = [...rowsOf(card)[2].querySelectorAll("span")]
      .filter((el) => el.className.includes("rounded-[10px]"))
    expect(chips).toHaveLength(3)
    for (const chip of chips) {
      expect(chip.className).toContain("min-w-0")
      expect(chip.className).not.toContain("flex-none")
    }
    expect(screen.getByTestId("board-rollup-PLA-12").className).toContain("flex-none")
  })

  it("expands the tray under the four rows, and collapses back to them", () => {
    const { card, rerender } = renderCard(item, { enrichment, expanded: true })
    expect(screen.getByTestId("board-card-tree")).toBeTruthy()
    expect(rowsOf(card)).toHaveLength(5)
    expect(screen.getByTestId("board-rollup-PLA-12").getAttribute("aria-expanded")).toBe("true")

    rerender(
      <BoardCard
        item={item}
        enrichment={enrichment}
        byName={new Map()}
        expanded={false}
        onToggleTree={() => {}}
        onOpen={() => {}}
        onOpenChild={() => {}}
        onAddSubTask={() => {}}
      />,
    )
    expect(screen.queryByTestId("board-card-tree")).toBeNull()
    expect(rowsOf(screen.getByTestId("board-card-PLA-12"))).toHaveLength(4)
  })
})

describe("a stopped card still leads with its cause", () => {
  it("puts the lead above all four rows", () => {
    const { card } = renderCard(compact({
      id: "PLA-13",
      status: "blocked",
      title: "Renew the provider contract",
      unblockHint: { what: "sign the renewal", who: "the operator" },
    }))
    const rows = rowsOf(card)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toBe(screen.getByTestId("stop-lead-PLA-13"))
    expect(rows[2].textContent).toBe("Renew the provider contract")
  })
})
