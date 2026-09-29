import type { ReactNode } from 'react'
import { ChevronDown, UserRound } from 'lucide-react'
import type { Employee, WorkItemFullWire } from '@/lib/api'
import { STATUS_LABEL, priorityLabel } from '@/lib/todos'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'
import { TodoMention } from '@/components/todo-mention'
import { StatusCircle } from '@/routes/todos/state-glyph'
import { RailPriorityBars } from '@/routes/todos/task-page/rail-rows'
import { displayNameOf } from '@/routes/todos/util'
import type { TodoQuickPickerKey, TodoQuickPickerRow } from '@/routes/todos/pickers/use-todo-quick-pickers'

/* The peek's property stack. Status and Assignee are the quick actions: the
 * chevron they already carried now has a picker behind it. Priority and Parent
 * stay read-only — the rail is a glance you can act on, not a second editor. */

const LABEL = 'w-[86px] flex-none text-[length:var(--text-caption1)] text-[var(--text-tertiary)]'

const VALUE =
  '-ml-[9px] inline-flex min-h-[34px] min-w-0 items-center gap-[7px] rounded-[var(--radius-md)] px-[9px] py-[5px] text-[length:var(--text-footnote)] text-[var(--text-primary)]'

function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-center" data-testid={`peek-prop-${label.toLowerCase()}`}>
      <span className={LABEL}>{label}</span>
      <span className={VALUE}>{children}</span>
    </div>
  )
}

/** A property the operator can change from here. The whole value is the target,
 *  34px tall so it stays a thumb-sized tap on the phone. The popover anchors on
 *  the row rather than the value column: the panel is 372px and clips its own
 *  overflow, and a 314px menu started at the value would lose 38px off the
 *  right edge. It still superimposes the row it belongs to. */
function EditableRow({ label, propertyKey, row, children }: {
  label: string
  propertyKey: TodoQuickPickerKey
  row: TodoQuickPickerRow
  children: ReactNode
}) {
  return (
    <div className="relative flex min-h-[34px] items-center" data-testid={`peek-prop-${propertyKey}`}>
      <span className={LABEL}>{label}</span>
      <span className="flex min-w-0">
        <button
          type="button"
          data-testid={`peek-row-${propertyKey}`}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={row.open}
          onClick={row.onOpen}
          className={`${VALUE} focus-ring cursor-default text-left outline-none transition-colors duration-150 hover:bg-[var(--fill-quaternary)] ${
            row.open ? 'bg-[var(--fill-quaternary)]' : ''
          }`}
        >
          {children}
          <ChevronDown
            size={11}
            strokeWidth={2}
            aria-hidden
            className={`flex-none text-[var(--text-quaternary)] ${row.open ? 'opacity-100' : 'opacity-45'}`}
          />
        </button>
      </span>
      {row.picker}
    </div>
  )
}

function AssigneeValue({ assignee, byName }: { assignee: string | null; byName: Map<string, Employee> }) {
  if (!assignee) {
    return (
      <>
        <span className="grid size-[18px] flex-none place-items-center rounded-full bg-[var(--fill-secondary)] text-[var(--text-quaternary)]">
          <UserRound size={10} aria-hidden />
        </span>
        <span className="text-[var(--text-tertiary)]">Unassigned</span>
      </>
    )
  }
  return (
    <>
      <EmployeeAvatar name={assignee} size={18} fontSize={10} className="bg-[var(--fill-secondary)]" />
      <span className="truncate">{displayNameOf(assignee, byName)}</span>
    </>
  )
}

export function TodoProps({ item, byName, parentTitle, rowFor }: {
  item: WorkItemFullWire
  byName: Map<string, Employee>
  parentTitle: string | null
  rowFor: (key: TodoQuickPickerKey) => TodoQuickPickerRow
}) {
  return (
    <div className="mt-[var(--space-4)] flex flex-col gap-0.5">
      <EditableRow label="Status" propertyKey="status" row={rowFor('status')}>
        <StatusCircle status={item.status} size={18} />
        {STATUS_LABEL[item.status]}
      </EditableRow>
      <EditableRow label="Assignee" propertyKey="assignee" row={rowFor('assignee')}>
        <AssigneeValue assignee={item.assignee} byName={byName} />
      </EditableRow>
      <PropRow label="Priority">
        <RailPriorityBars priority={item.priority} />
        {priorityLabel(item.priority)}
      </PropRow>
      <PropRow label="Parent">
        {item.parentId ? (
          <>
            <TodoMention id={item.parentId} />
            {parentTitle && <span className="truncate">{parentTitle}</span>}
          </>
        ) : (
          <span className="text-[var(--text-tertiary)]">No parent</span>
        )}
      </PropRow>
    </div>
  )
}
