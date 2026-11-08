import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Employee } from "@/lib/api"
import { workItemNode } from "./fixtures/task-wire"
import { SubTaskRow } from "../task-page/subtask-row"
import { AssigneePickerContent } from "../pickers/picker-contents"

/* Where an assign picker has no person slot beside it (a sub-task row, the search workbench's Owner), "You (operator)" stays:
 * it is the only way to assign that Todo to yourself, on every instance. Beside a person slot the operator is chosen there. */

const employees: Employee[] = [{ name: "mason", displayName: "Mason", department: "platform", rank: "senior", engine: "codex", model: "m", persona: "p" }]

describe("assigning yourself where there is no person slot", () => {
  it("offers You (operator) first in a sub-task's assign picker, and assigns the operator through the assign lane", () => {
    const onChildAssign = vi.fn()
    render(
      <SubTaskRow child={workItemNode("TSK-13", { status: "backlog" })} employees={employees} mobile={false} picking="assign"
        onPick={vi.fn()} onOpenChild={vi.fn()} onChildStatus={vi.fn()} onChildAssign={onChildAssign} />,
    )
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="assignee-option-"]')].map((row) => row.dataset.testid)
    expect(rows).toEqual(["assignee-option-@operator", "assignee-option-mason"])
    fireEvent.click(screen.getByTestId("assignee-option-@operator"))
    expect(onChildAssign).toHaveBeenCalledWith("TSK-13", "@operator")
  })

  it("marks the operator as chosen and offers the clear when the Todo waits on them", () => {
    const commit = vi.fn()
    render(<AssigneePickerContent detail={{ workItem: workItemNode("TSK-13", { assignee: "@operator" }), spendUsd: 0, events: [] }} employees={employees} commit={commit} onDone={vi.fn()} offerOperator />)
    // The chosen row carries the check mark; no other row does.
    expect(screen.getByTestId("assignee-option-@operator").querySelector("svg.ml-auto")).toBeTruthy()
    expect(screen.getByTestId("assignee-option-mason").querySelector("svg.ml-auto")).toBeNull()
    fireEvent.click(screen.getByTestId("assignee-option-unassign"))
    expect(commit).toHaveBeenCalledWith(null)
  })

  it("keeps the agent picker beside a person slot to employees only", () => {
    render(<AssigneePickerContent detail={{ workItem: workItemNode("TSK-13", { assignee: "@operator" }), spendUsd: 0, events: [] }} employees={employees} commit={vi.fn()} onDone={vi.fn()} />)
    expect(screen.queryByTestId("assignee-option-@operator")).toBeNull()
    expect(screen.queryByTestId("assignee-option-unassign")).toBeNull()
  })
})
