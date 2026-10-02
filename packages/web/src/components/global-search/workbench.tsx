import { useEffect, useRef, type ReactNode } from "react"
import { useMentionPicker } from "@/components/mention-picker"
import { STATUS_LABEL } from "@/lib/todos"
import { StatusCircle } from "@/routes/todos/state-glyph"
import type { TodoQuickPickerKey } from "@/routes/todos/pickers/use-todo-quick-pickers"
import { WORKBENCH_PREFIX, type TodoWorkbench } from "./use-todo-workbench"

/* The preview's write half, for Todo rows only. Three things the operator can
 * do without leaving the overlay — move it, hand it over, say something — laid
 * out as two disclosure rows and a composer. The pickers open in flow rather
 * than over the anchor: this pane scrolls its own body and sits inside a modal
 * that traps focus, and an in-flow disclosure is the one form that survives
 * both, at 1440 and at 390 alike. */

const FIELD = "flex w-full min-h-[34px] items-center gap-3 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-left outline-none focus-visible:bg-[var(--fill-secondary)]"
const FIELD_LABEL = "flex-none text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-quaternary)]"
const FIELD_VALUE = "ml-auto flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium text-[var(--text-primary)]"
const COMPOSER = "w-full resize-none rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-2 text-[13.5px] leading-[1.45] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]"
const SEND = "min-h-[34px] rounded-[var(--radius-md)] bg-[var(--accent-fill)] px-3.5 text-[12.5px] font-medium text-[var(--accent)] disabled:opacity-40"
const QUIET = "mt-4 text-[13px] text-[var(--text-tertiary)]"

export function WorkbenchField({ field, label, value, workbench, primary = false }: {
  field: TodoQuickPickerKey
  label: string
  value: ReactNode
  workbench: TodoWorkbench
  /** The control this surface's ⏎ hands the field over to. */
  primary?: boolean
}) {
  const row = workbench.rowFor(field)
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        data-testid={`${WORKBENCH_PREFIX}-row-${field}`}
        {...(primary ? { "data-command-primary": "" } : {})}
        aria-haspopup="menu"
        aria-expanded={row.open}
        onClick={row.onOpen}
        className={FIELD}
      >
        <span className={FIELD_LABEL}>{label}</span>
        <span className={FIELD_VALUE}>{value}</span>
      </button>
      {row.picker}
    </div>
  )
}

function Composer({ workbench }: { workbench: TodoWorkbench }) {
  const { comment, id } = workbench
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const picker = useMentionPicker({
    value: comment.draft,
    setValue: comment.setDraft,
    employees: workbench.employees,
    textareaRef: inputRef,
  })
  const { onPickerOpenChange } = workbench
  useEffect(() => {
    onPickerOpenChange(picker.open)
    return () => onPickerOpenChange(false)
  }, [picker.open, onPickerOpenChange])
  return (
    <div className="mt-2">
      <div className="relative">
      {picker.list}
      <textarea
        ref={inputRef}
        rows={2}
        value={comment.draft}
        onChange={picker.onChange}
        onSelect={picker.onSelect}
        onKeyDown={event => {
          if (picker.onKeyDown(event)) return
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          comment.submit()
        }}
        placeholder="Leave a comment…"
        aria-label={`Comment on ${id}`}
        data-testid="workbench-comment"
        className={COMPOSER}
      />
      </div>
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={comment.submit}
          disabled={comment.draft.trim().length === 0 || comment.pending}
          data-testid="workbench-comment-send"
          className={SEND}
        >
          {comment.pending ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  )
}

export function Workbench({ workbench }: { workbench: TodoWorkbench }) {
  if (workbench.loading) return <p className={QUIET}>Loading {workbench.id}…</p>
  if (workbench.missing) {
    return (
      <p className={QUIET} data-testid="workbench-missing">
        Couldn&apos;t load {workbench.id}. It may have been deleted — open it to check.
      </p>
    )
  }

  const status = workbench.status
  return (
    <div className="mt-4" data-search-workbench="" data-testid="search-workbench">
      <div className="flex flex-wrap items-start gap-2">
        <WorkbenchField
          field="status"
          label="Status"
          value={status ? <><StatusCircle status={status} size={14} />{STATUS_LABEL[status]}</> : "—"}
          workbench={workbench}
        />
        <WorkbenchField
          field="assignee"
          label="Owner"
          value={workbench.assignee ?? <span className="text-[var(--text-tertiary)]">Unassigned</span>}
          workbench={workbench}
        />
      </div>
      <Composer workbench={workbench} />
      {workbench.error && (
        <p className="mt-2 text-[12.5px] leading-[1.4] text-[var(--system-red)]" data-testid="workbench-error">
          {workbench.error}
        </p>
      )}
    </div>
  )
}
