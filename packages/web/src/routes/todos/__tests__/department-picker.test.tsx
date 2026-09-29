import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DepartmentSummaryWire, WorkItemDetailWire } from "@/lib/api"
import { creatableDepartment, offeredDepartments } from "../pickers/department-filters"
import { DepartmentPickerContent } from "../pickers/picker-contents"

/* JIN-1 — under a configured `gateway.todoDepartments` the gateway marks every
 * other registered department unselectable. The picker stops offering those,
 * but still shows the one the Todo already sits in so the current value reads. */

const DEPARTMENTS: DepartmentSummaryWire[] = [
  { slug: "labs", prefix: "LAB", createdAt: "2026-09-27T00:00:00.000Z", todoCount: 3, selectable: true },
  { slug: "general", prefix: "GEN", createdAt: "2026-08-13T00:00:00.000Z", todoCount: 9, selectable: true },
  { slug: "engineering", prefix: "ENG", createdAt: "2026-09-18T00:00:00.000Z", todoCount: 1, selectable: false },
]

function detailIn(department: string | null): WorkItemDetailWire {
  return { workItem: { id: "TST-1", department } as WorkItemDetailWire["workItem"], spendUsd: 0, events: [] }
}

function renderPicker(department: string | null, departments = DEPARTMENTS) {
  return render(<DepartmentPickerContent detail={detailIn(department)} departments={offeredDepartments(departments, department)} commit={() => {}} onDone={() => {}} />)
}

describe("DepartmentPickerContent", () => {
  it("does not offer a department outside the configured set", () => {
    renderPicker("general")
    expect(screen.getByTestId("department-option-labs")).toBeTruthy()
    expect(screen.getByTestId("department-option-general")).toBeTruthy()
    expect(screen.queryByTestId("department-option-engineering")).toBeNull()
  })

  it("still shows the unselectable department a Todo already sits in", () => {
    renderPicker("engineering")
    expect(screen.getByTestId("department-option-engineering")).toBeTruthy()
  })

  it("offers everything when the gateway sends no selectable flag (open departments)", () => {
    renderPicker(null, DEPARTMENTS.map(({ selectable: _selectable, ...rest }) => rest))
    expect(screen.getByTestId("department-option-engineering")).toBeTruthy()
  })
})

describe("the shared department filters", () => {
  it("offers the same rows the picker renders, so row indices line up", () => {
    expect(offeredDepartments(DEPARTMENTS, "general").map((d) => d.slug)).toEqual(["labs", "general"])
    expect(offeredDepartments(DEPARTMENTS, "engineering").map((d) => d.slug)).toEqual(["labs", "general", "engineering"])
  })

  it("drops a legacy board's department from a new Todo's seed", () => {
    expect(creatableDepartment(DEPARTMENTS, "engineering")).toBeNull()
    expect(creatableDepartment(DEPARTMENTS, "labs")).toBe("labs")
    expect(creatableDepartment(DEPARTMENTS, undefined)).toBeNull()
    expect(creatableDepartment([], "anything")).toBe("anything")
  })

  it("drops a slug the gateway never registered when a policy is visible, keeps it when departments are open", () => {
    expect(creatableDepartment(DEPARTMENTS, "marketing")).toBeNull()
    const open = DEPARTMENTS.map(({ selectable: _selectable, ...rest }) => rest)
    expect(creatableDepartment(open, "marketing")).toBe("marketing")
  })
})
