import { useCallback, useMemo, useRef, useState } from "react"
import {
  Building2,
  CalendarDays,
  Flag,
  GitBranch,
  Tags,
  UserRound,
} from "@/components/ui/icon"
import {
  api,
  type DepartmentSummaryWire,
  type Employee,
} from "@/lib/api"
import { operatorSafeTodoError, priorityLabel } from "@/lib/todos"
import { createDetail } from "./new-todo-preview"
import { PropertyChip, useIsCreateMobile } from "./new-todo-chips"
import { AssignOnCreateError, assignOnCreate } from "./new-todo-assign"
import { MemberName } from "./attribution"
import { OPERATOR_ASSIGNEE } from "./util"
import { TodoDialog } from "./todo-dialog"
import {
  AssigneePickerContent,
  DepartmentPickerContent,
  DuePickerContent,
  LabelsPickerContent,
  PriorityPickerContent,
} from "./pickers/picker-contents"
import { PersonPickerContent } from "./pickers/person-picker-content"
import { PickerPopover, PickerSheet } from "./pickers/picker-shell"
import { creatableDepartment, offeredDepartments } from "./pickers/department-filters"

type CreatePicker = "assignee" | "person" | "department" | "priority" | "due" | "labels"

export function NewTodoDialog({
  onClose,
  onCreated,
  defaults,
}: {
  onClose: () => void
  onCreated: () => void
  defaults?: {
    /** Seeds the title, so a create started from the palette keeps its words. */
    title?: string
    department?: string
    askAssignee?: boolean
    employees?: Employee[]
    departments?: DepartmentSummaryWire[]
  }
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const mobile = useIsCreateMobile()
  const [title, setTitle] = useState(defaults?.title ?? "")
  const [body, setBody] = useState("")
  const [parentId, setParentId] = useState("")
  const seededDepartment = creatableDepartment(defaults?.departments ?? [], defaults?.department)
  const [department, setDepartment] = useState<string | null>(seededDepartment)
  const [assignee, setAssignee] = useState<string | null>(null)
  const [person, setPerson] = useState<string | null>(null)
  const [priority, setPriority] = useState(0)
  const [dueAt, setDueAt] = useState<string | null>(null)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [picker, setPicker] = useState<CreatePicker | null>(null)
  const [showParent, setShowParent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // The exit plays before the board is told, so which ending it was has to survive the animation.
  const [leaving, setLeaving] = useState<"closed" | "created" | null>(null)

  const selectedLabels = useMemo(
    () => labelIds.map((id) => ({ id, name: id, color: null, department: null, createdAt: "" })),
    [labelIds],
  )
  const employee = defaults?.employees?.find((candidate) => candidate.name === assignee)
  const detail = useMemo(() => createDetail({
    title,
    department,
    assignee,
    humanAssignee: person,
    priority,
    dueAt,
    labels: selectedLabels,
  }), [title, department, assignee, person, priority, dueAt, selectedLabels])
  const dirty = Boolean(
    title.trim() || body.trim() || parentId.trim() || assignee || person
    || priority || dueAt || labelIds.length || department !== seededDepartment,
  )

  const reset = useCallback(() => {
    setTitle("")
    setBody("")
    setParentId("")
    setDepartment(seededDepartment)
    setAssignee(null)
    setPerson(null)
    setPriority(0)
    setDueAt(null)
    setLabelIds([])
    setPicker(null)
    setShowParent(false)
    setError(null)
  }, [seededDepartment])

  /** A board member is a person only on a board they can reach, so moving the draft to another board lets them go. */
  const commitDepartment = useCallback((next: string | null) => {
    setDepartment(next)
    if (next !== department) setPerson((current) => (current === OPERATOR_ASSIGNEE ? current : null))
  }, [department])

  const create = useCallback(async (keepOpen: boolean) => {
    const nextTitle = title.trim()
    if (!nextTitle || busy) return
    if (defaults?.askAssignee && !assignee && !person) {
      setError("Pick who this is assigned to")
      setPicker("assignee")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await api.createWorkItem({
        title: nextTitle,
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(parentId.trim() ? { parentId: parentId.trim() } : {}),
        ...(department ? { department } : {}),
        ...(priority ? { priority } : {}),
        ...(dueAt ? { dueAt } : {}),
        ...(labelIds.length ? { labels: labelIds } : {}),
      })
      try {
        await assignOnCreate(created.workItem, { assignee, person })
      } catch (caught) {
        // The Todo exists: clear the form so another click cannot create it again, and say which slot is still unset.
        reset()
        setBusy(false)
        setError(`Created ${created.workItem.id}, but couldn't set the ${caught instanceof AssignOnCreateError ? caught.slot : "agent or person"}. Set it on the Todo.`)
        return
      }
      if (keepOpen) {
        reset()
        setBusy(false)
        requestAnimationFrame(() => titleRef.current?.focus())
      } else {
        setLeaving("created")
      }
    } catch (caught) {
      setBusy(false)
      setError(operatorSafeTodoError(caught, "Failed to create"))
    }
  }, [assignee, person, body, busy, department, dueAt, labelIds, parentId, priority, reset, title, defaults?.askAssignee])

  const closePicker = () => setPicker(null)
  const togglePicker = (next: CreatePicker) => setPicker((current) => current === next ? null : next)
  const pickerTitle: Record<CreatePicker, string> = {
    assignee: "Agent",
    person: "Person",
    department: "Department",
    priority: "Priority",
    due: "Due date",
    labels: "Labels",
  }
  const pickerContent = (kind: CreatePicker, sheet: boolean) => {
    const common = { detail, sheet, onDone: closePicker }
    switch (kind) {
      case "assignee":
        return <AssigneePickerContent {...common} employees={defaults?.employees ?? []} commit={setAssignee} />
      case "person":
        return <PersonPickerContent {...common} commit={setPerson} board={department} />
      case "department":
        return <DepartmentPickerContent {...common} departments={offeredDepartments(defaults?.departments ?? [], department)} commit={commitDepartment} />
      case "priority":
        return <PriorityPickerContent {...common} commit={setPriority} />
      case "due":
        return <DuePickerContent {...common} commit={setDueAt} />
      case "labels":
        return <LabelsPickerContent {...common} commit={setLabelIds} />
    }
  }
  const desktopPicker = (kind: CreatePicker, currentIndex = 0) =>
    picker === kind && !mobile ? (
      <PickerPopover label={pickerTitle[kind]} onClose={closePicker} currentIndex={currentIndex} testId={`todo-new-${kind}-picker`}>
        {pickerContent(kind, false)}
      </PickerPopover>
    ) : null

  return (
    <TodoDialog
      label="New todo"
      open={leaving === null}
      onRequestClose={() => { if (busy) return; if (dirty) setConfirmDiscard(true); else setLeaving("closed") }}
      onClosed={leaving === "created" ? onCreated : onClose}
      className="inset-x-3 bottom-3 max-h-[calc(100dvh-24px)] overflow-y-auto rounded-[var(--radius-xl)] px-5 py-5 pb-[max(20px,env(safe-area-inset-bottom))] sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[min(620px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:px-7 sm:py-6"
    >
      <div
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !event.metaKey) return
          event.preventDefault()
          void create(event.shiftKey)
        }}
      >
        <div className="text-[11px] font-semibold uppercase tracking-[0.11em] text-[var(--text-quaternary)]">
          Todos <span className="px-1 opacity-50">/</span> New
        </div>
        <input
          ref={titleRef}
          autoFocus
          aria-label="Todo title"
          data-testid="todo-new-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs to happen?"
          className="mt-3 w-full bg-transparent text-[28px] font-semibold leading-tight tracking-[-0.025em] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] sm:text-[32px]"
        />
        <textarea
          aria-label="Description"
          data-testid="todo-new-description"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add context, constraints, or links…"
          rows={3}
          className="mt-3 min-h-[78px] w-full resize-y bg-transparent text-[14px] leading-6 text-[var(--text-secondary)] outline-none placeholder:text-[var(--text-quaternary)]"
        />

        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--separator)] pt-4">
          {defaults?.askAssignee && (
            <select
              aria-hidden="true"
              tabIndex={-1}
              data-testid="todo-new-assignee"
              value={assignee ?? ""}
              onChange={(event) => setAssignee(event.target.value || null)}
              className="sr-only"
            >
              <option value="">Assign to…</option>
              {(defaults.employees ?? []).map((candidate) => (
                <option key={candidate.name} value={candidate.name}>{candidate.displayName}</option>
              ))}
            </select>
          )}
          <PropertyChip
            icon={<UserRound size={13} aria-hidden />}
            label={employee?.displayName ?? (defaults?.askAssignee && !person ? "Agent required" : "Agent")}
            testId="todo-new-assignee-chip"
            active={picker === "assignee"}
            onClick={() => togglePicker("assignee")}
          >
            {desktopPicker("assignee")}
          </PropertyChip>
          <PropertyChip
            icon={<UserRound size={13} aria-hidden />}
            label={person ? (person === OPERATOR_ASSIGNEE ? "You (operator)" : <MemberName identity={person} />) : "Person"}
            testId="todo-new-person-chip"
            active={picker === "person"}
            onClick={() => togglePicker("person")}
          >
            {desktopPicker("person")}
          </PropertyChip>
          <PropertyChip
            icon={<Building2 size={13} aria-hidden />}
            label={department ? department.charAt(0).toUpperCase() + department.slice(1) : "Department"}
            testId="todo-new-department-chip"
            active={picker === "department"}
            onClick={() => togglePicker("department")}
          >
            {desktopPicker("department", Math.max(0, offeredDepartments(defaults?.departments ?? [], department).findIndex((item) => item.slug === department)))}
          </PropertyChip>
          <PropertyChip
            icon={<Flag size={13} aria-hidden />}
            label={priority ? priorityLabel(priority) : "Priority"}
            testId="todo-new-priority-chip"
            active={picker === "priority"}
            onClick={() => togglePicker("priority")}
          >
            {desktopPicker("priority", Math.max(0, 3 - priority))}
          </PropertyChip>
          <PropertyChip
            icon={<CalendarDays size={13} aria-hidden />}
            label={dueAt ? new Date(dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Due"}
            testId="todo-new-due-chip"
            active={picker === "due"}
            onClick={() => togglePicker("due")}
          >
            {desktopPicker("due")}
          </PropertyChip>
          <PropertyChip
            icon={<Tags size={13} aria-hidden />}
            label={labelIds.length ? `${labelIds.length} label${labelIds.length === 1 ? "" : "s"}` : "Labels"}
            testId="todo-new-labels-chip"
            active={picker === "labels"}
            onClick={() => togglePicker("labels")}
          >
            {desktopPicker("labels")}
          </PropertyChip>
          <PropertyChip
            icon={<GitBranch size={13} aria-hidden />}
            label={parentId || "Parent"}
            testId="todo-new-parent-chip"
            active={showParent}
            onClick={() => setShowParent((shown) => !shown)}
          />
        </div>

        {showParent && (
          <div className="mt-4 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3">
            <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-quaternary)]">
              Parent Todo
              <input
                autoFocus
                data-testid="todo-new-parent"
                value={parentId}
                onChange={(event) => setParentId(event.target.value)}
                placeholder="e.g. OPS-2"
                className="apple-input mt-1.5 min-h-10 w-full normal-case tracking-normal"
              />
            </label>
          </div>
        )}

        {error && <div className="mt-3 text-[length:var(--text-caption1)] text-[var(--system-red)]">{error}</div>}
        {confirmDiscard && (
          <div className="mt-3 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] p-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            <p>Discard this Todo draft?</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => setLeaving("closed")} className="min-h-11 rounded-full px-3 font-semibold text-[var(--system-red)]">Discard</button>
              <button type="button" onClick={() => setConfirmDiscard(false)} className="min-h-11 rounded-full px-3 text-[var(--text-secondary)]">Keep editing</button>
            </div>
          </div>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--separator)] pt-4">
          <button
            type="button"
            data-testid="todo-new-create-more"
            disabled={!title.trim() || busy}
            onClick={() => void create(true)}
            className="focus-outline min-h-11 rounded-full px-3 text-[12px] font-semibold text-[var(--text-tertiary)] outline-none hover:bg-[var(--fill-tertiary)] disabled:opacity-40"
          >
            Create more <span className="ml-1 font-normal opacity-60">⇧⌘↵</span>
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => { if (dirty) setConfirmDiscard(true); else setLeaving("closed") }}
            className="focus-outline min-h-11 rounded-full px-4 text-[length:var(--text-subheadline)] font-medium text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="todo-new-create"
            disabled={!title.trim() || busy}
            onClick={() => void create(false)}
            className="focus-outline min-h-11 rounded-full bg-[var(--accent)] px-5 text-[length:var(--text-subheadline)] font-semibold text-[var(--accent-contrast)] outline-none transition-transform hover:scale-[0.98] disabled:opacity-40" // jinn-shell: ok dialog submit, not page chrome
          >
            {busy ? "Creating…" : "Create todo"}
          </button>
        </div>
      </div>

      {picker && mobile && (
        <PickerSheet title={pickerTitle[picker]} onClose={closePicker} testId={`todo-new-${picker}-sheet`}>
          {pickerContent(picker, true)}
        </PickerSheet>
      )}
    </TodoDialog>
  )
}
