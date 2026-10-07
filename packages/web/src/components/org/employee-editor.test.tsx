import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Employee } from "@/lib/api"

// ModelSelectorRow has its own tests + needs the model registry; stub it here so
// this test focuses on the editor's own behavior (validation, diffing, save).
vi.mock("@/components/chat/model-selector-row", () => ({
  ModelSelectorRow: ({ value, onChange }: {
    value: { engine: string; model?: string; effortLevel?: string }
    onChange: (next: { engine: string; model?: string; effortLevel?: string }) => void
  }) => (
    <button
      type="button"
      data-testid="model-selector"
      onClick={() => onChange({ ...value, model: "gpt-5.5", effortLevel: "medium" })}
    >
      Change runtime
    </button>
  ),
}))

const updateEmployee = vi.fn()
const getOrg = vi.fn()
vi.mock("@/lib/api", () => ({
  api: {
    updateEmployee: (...a: unknown[]) => updateEmployee(...a),
    getOrg: (...a: unknown[]) => getOrg(...a),
  },
}))

import { EmployeeEditor } from "./employee-editor"

const EMP: Employee = {
  name: "content-writer",
  displayName: "Content Writer",
  department: "content",
  rank: "employee",
  engine: "claude",
  model: "sonnet",
  persona: "You write blog posts.",
}

const saveBtn = () => screen.getByRole("button", { name: /^(Save|Saving)/ }) as HTMLButtonElement

beforeEach(() => {
  updateEmployee.mockReset()
  getOrg.mockReset()
  getOrg.mockResolvedValue({ departments: ["content"], employees: [{ name: "content-lead" }] })
})

describe("EmployeeEditor", () => {
  it("disables Save when pristine and when persona is emptied", () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    expect(saveBtn().disabled).toBe(true) // pristine

    const persona = screen.getByDisplayValue("You write blog posts.")
    fireEvent.change(persona, { target: { value: "   " } })
    expect(saveBtn().disabled).toBe(true)
    expect(screen.getByText("Persona cannot be empty.")).toBeTruthy()
  })

  it("sends only the changed fields and calls onSaved on success", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, persona: "New persona." } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "New persona." } })
    expect(saveBtn().disabled).toBe(false)
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledTimes(1))
    expect(updateEmployee).toHaveBeenCalledWith("content-writer", { persona: "New persona." })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...EMP, persona: "New persona." }))
  })

  it("keeps the form open and shows the error on a failed save", async () => {
    const onSaved = vi.fn()
    updateEmployee.mockRejectedValue(new Error("rank must be one of ..."))
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={onSaved} />)

    fireEvent.change(screen.getByDisplayValue("You write blog posts."), { target: { value: "Changed." } })
    fireEvent.click(saveBtn())

    await waitFor(() => expect(screen.getByText("rank must be one of ...")).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
    expect(saveBtn()).toBeTruthy() // still open
  })

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn()
    render(<EmployeeEditor employee={EMP} onCancel={onCancel} onSaved={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("locks system identity fields while keeping runtime knobs editable", async () => {
    const systemEmployee: Employee = {
      ...EMP,
      name: "todo-dispatcher",
      displayName: "Todo Dispatcher",
      department: "system",
      rank: "senior",
      engine: "codex",
      model: "gpt-5.6-sol",
      effortLevel: "high",
      persona: "Choose the best employee and hand the Todo off.",
      cliFlags: ["--system-flag"],
      reportsTo: "operations-lead",
      system: true,
    }
    updateEmployee.mockResolvedValue({
      status: "ok",
      employee: { ...systemEmployee, model: "gpt-5.5", effortLevel: "medium" },
    })

    render(<EmployeeEditor employee={systemEmployee} onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByText("System")).toBeTruthy()
    expect(screen.getByTestId("system-readonly-rank").textContent).toBe("Senior")
    expect(screen.getByTestId("system-readonly-department").textContent).toBe("system")
    expect(screen.getByTestId("system-readonly-persona").textContent).toContain("Choose the best employee")
    expect(screen.queryByDisplayValue("Choose the best employee and hand the Todo off.")).toBeNull()
    expect(screen.queryByDisplayValue("--system-flag")).toBeNull()

    fireEvent.click(screen.getByTestId("model-selector"))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("todo-dispatcher", {
      model: "gpt-5.5",
      effortLevel: "medium",
    }))
  })
})

describe("EmployeeEditor department scope", () => {
  // Radix Select measures and captures the pointer; jsdom implements neither.
  beforeEach(() => {
    Element.prototype.hasPointerCapture ??= () => false
    Element.prototype.releasePointerCapture ??= () => {}
    Element.prototype.scrollIntoView ??= () => {}
  })

  beforeEach(() => {
    getOrg.mockResolvedValue({
      departments: ["content", "design", "studio", "vault"],
      departmentScopes: { content: "open", studio: "scoped", vault: "dedicated" },
      employees: [],
    })
  })

  async function departmentOptions() {
    const trigger = await screen.findByRole("combobox", { name: "Department" })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" })
    const options = await screen.findAllByRole("option")
    return options.map((option) => ({
      label: option.textContent,
      disabled: option.getAttribute("aria-disabled") === "true",
    }))
  }

  it("offers open departments and shows scoped and dedicated ones disabled, with the reason", async () => {
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("department-file-move-hint")).toBeTruthy())

    expect(await departmentOptions()).toEqual([
      { label: "None", disabled: false },
      { label: "content", disabled: false },
      { label: "design", disabled: false },
      { label: "studio · scoped", disabled: true },
      { label: "vault · dedicated", disabled: true },
    ])
    expect(screen.getByTestId("department-file-move-hint").textContent)
      .toBe("Scope follows the file location under org/<slug>; move the YAML by hand.")
  })

  it("moves an employee between open departments as before", async () => {
    updateEmployee.mockResolvedValue({ status: "ok", employee: { ...EMP, department: "design" } })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("department-file-move-hint")).toBeTruthy())

    await departmentOptions()
    fireEvent.click(screen.getByRole("option", { name: "design" }))
    fireEvent.click(saveBtn())

    await waitFor(() => expect(updateEmployee).toHaveBeenCalledWith("content-writer", { department: "design" }))
  })

  it("makes the department read-only for a member of a scoped department", async () => {
    render(<EmployeeEditor employee={{ ...EMP, department: "studio" }} onCancel={() => {}} onSaved={() => {}} />)

    await waitFor(() => expect(screen.getByTestId("confined-readonly-department").textContent).toBe("studio"))
    expect(screen.queryByRole("combobox", { name: "Department" })).toBeNull()
    expect(screen.getByTestId("department-file-move-hint").textContent)
      .toBe("Scope follows the file location under org/studio; move the YAML by hand.")
  })

  it("makes the department read-only for a member of a dedicated department", async () => {
    render(<EmployeeEditor employee={{ ...EMP, department: "vault" }} onCancel={() => {}} onSaved={() => {}} />)

    await waitFor(() => expect(screen.getByTestId("confined-readonly-department").textContent).toBe("vault"))
    expect(screen.getByTestId("department-file-move-hint").textContent)
      .toBe("Scope follows the file location under org/vault; move the YAML by hand.")
  })

  it("keeps the department read-only until the org has loaded", async () => {
    let resolveOrg: (org: unknown) => void = () => {}
    getOrg.mockReturnValue(new Promise((resolve) => { resolveOrg = resolve }))
    render(<EmployeeEditor employee={{ ...EMP, department: "studio" }} onCancel={() => {}} onSaved={() => {}} />)

    expect(screen.getByTestId("pending-readonly-department").textContent).toBe("studio")
    expect(screen.queryByRole("combobox", { name: "Department" })).toBeNull()

    resolveOrg({ departments: ["content", "studio"], departmentScopes: { content: "open", studio: "scoped" }, employees: [] })
    await waitFor(() => expect(screen.getByTestId("confined-readonly-department").textContent).toBe("studio"))
  })

  it("shows no hint when every department is open", async () => {
    getOrg.mockResolvedValue({ departments: ["content", "design"], departmentScopes: { content: "open", design: "open" }, employees: [] })
    render(<EmployeeEditor employee={EMP} onCancel={() => {}} onSaved={() => {}} />)

    expect((await departmentOptions()).every((option) => !option.disabled)).toBe(true)
    expect(screen.queryByTestId("department-file-move-hint")).toBeNull()
  })
})
