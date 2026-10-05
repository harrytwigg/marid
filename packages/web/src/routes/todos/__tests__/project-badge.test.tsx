import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { WorkItemCompactWire } from "@/lib/api"
import type { ProjectRefWire } from "@/lib/project-api"
import { BoardCard } from "../board/card"
import { TodoListRow } from "../list/list-row"
import { ProjectBadge } from "../projects/project-badge"

/* The project badge on the board card and the list row: a project's name in its
 * own hue, nothing for a company-level Todo, and a muted read for a project
 * that is archived or that no definition file names. */

vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`} />,
}))

const GARDEN: ProjectRefWire = { id: "prj_garden000001", name: "Garden Planner", archived: false, known: true }
const BOAT: ProjectRefWire = { id: "prj_boat00000001", name: "Boat Club", archived: false, known: true }
const OLD: ProjectRefWire = { id: "prj_old000000001", name: "Retired Orchard", archived: true, known: true }
const GONE: ProjectRefWire = { id: "prj_gone00000001", name: "prj_gone00000001", archived: false, known: false }

function compact(project?: ProjectRefWire | null): WorkItemCompactWire {
  return {
    id: "PLA-1",
    version: 1,
    title: "Water the beds",
    status: "executing",
    assignee: "scout",
    department: "platform",
    source: "human",
    sourceRef: null,
    createdBy: "operator",
    parentId: null,
    rootId: "PLA-1",
    depth: 0,
    dueAt: null,
    labels: [],
    blocked: false,
    updatedAt: "2026-08-21T08:00:00.000Z",
    rank: null,
    ...(project === undefined ? {} : { project }),
  } as WorkItemCompactWire
}

function renderCard(item: WorkItemCompactWire) {
  render(
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
  return screen.getByTestId(`board-card-${item.id}`)
}

function renderRow(item: WorkItemCompactWire) {
  render(<TodoListRow item={item} priority={2} byName={new Map()} now={Date.parse("2026-08-21T09:00:00.000Z")} onOpen={() => {}} />)
  return screen.getByTestId(`todo-list-row-${item.id}`)
}

const hueOf = (el: HTMLElement) => el.style.getPropertyValue("--project-h")

describe("ProjectBadge", () => {
  it("shows a live project's name, tinted with the hue its id gives it", () => {
    render(<ProjectBadge project={GARDEN} />)
    const badge = screen.getByTestId("project-badge")
    expect(badge.textContent).toBe("Garden Planner")
    expect(badge.getAttribute("data-project-state")).toBe("active")
    expect(hueOf(badge)).toMatch(/^\d+$/)
    expect(badge.className).toContain("hsl(var(--project-h)")
  })

  it("keeps one hue per project across a rename, and gives different projects different hues", () => {
    const { rerender } = render(<ProjectBadge project={GARDEN} />)
    const before = hueOf(screen.getByTestId("project-badge"))
    rerender(<ProjectBadge project={{ ...GARDEN, name: "Allotment Planner" }} />)
    expect(hueOf(screen.getByTestId("project-badge"))).toBe(before)
    rerender(<ProjectBadge project={BOAT} />)
    expect(hueOf(screen.getByTestId("project-badge"))).not.toBe(before)
  })

  it("renders nothing for a company-level Todo", () => {
    const { container, rerender } = render(<ProjectBadge project={null} />)
    expect(container.firstChild).toBeNull()
    rerender(<ProjectBadge project={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it("mutes an archived project and says so", () => {
    render(<ProjectBadge project={OLD} />)
    const badge = screen.getByTestId("project-badge")
    expect(badge.getAttribute("data-project-state")).toBe("archived")
    expect(badge.textContent).toContain("Retired Orchard")
    expect(badge.textContent).toContain("archived")
    expect(badge.className).toContain("text-[var(--text-quaternary)]")
    expect(badge.className).not.toContain("hsl(var(--project-h)_42%")
    expect(badge.title).toBe("Retired Orchard (archived project)")
  })

  it("reads 'unknown project', muted, for an id no definition file names", () => {
    render(<ProjectBadge project={GONE} />)
    const badge = screen.getByTestId("project-badge")
    expect(badge.getAttribute("data-project-state")).toBe("unknown")
    expect(badge.textContent).toBe("unknown project")
    expect(badge.className).toContain("text-[var(--text-quaternary)]")
    expect(badge.title).toContain("prj_gone00000001")
  })
})

describe("on the board card", () => {
  it("sits in row 1, beside the ID and ahead of the assignee", () => {
    const card = renderCard(compact(GARDEN))
    const row1 = card.children[0] as HTMLElement
    expect(row1.contains(screen.getByTestId("project-badge"))).toBe(true)
    expect(row1.textContent).toContain("PLA-1")
    expect(row1.textContent).toContain("Garden Planner")
  })

  it("leaves row 1 alone for a company-level Todo", () => {
    const card = renderCard(compact(null))
    expect(screen.queryByTestId("project-badge")).toBeNull()
    expect((card.children[0] as HTMLElement).textContent).toBe("PLA-1")
  })

  it("shows the muted variants for archived and unknown projects", () => {
    renderCard(compact(OLD))
    expect(screen.getByTestId("project-badge").getAttribute("data-project-state")).toBe("archived")
  })

  it("treats a gateway that omits the field as company-level", () => {
    renderCard(compact(undefined))
    expect(screen.queryByTestId("project-badge")).toBeNull()
  })
})

describe("on the list row", () => {
  it("shows the project beside the title", () => {
    const row = renderRow(compact(BOAT))
    expect(row.contains(screen.getByTestId("project-badge"))).toBe(true)
    expect(screen.getByTestId("project-badge").textContent).toBe("Boat Club")
  })

  it("shows 'unknown project' for an id with no definition", () => {
    renderRow(compact(GONE))
    expect(screen.getByTestId("project-badge").textContent).toBe("unknown project")
  })

  it("shows no badge at company level", () => {
    renderRow(compact(null))
    expect(screen.queryByTestId("project-badge")).toBeNull()
  })
})
