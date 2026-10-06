import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { todoPath } from '@/lib/todo-id'
import { TodoPeek } from './todo-peek'

/**
 * A Todo opened as a tab: the peek panel's body (the glance, with Status and Assignee editable), in
 * the pane instead of a drawer beside the grid. The full page stays one click away, as it is from
 * the panel, and a modified click on the mention still goes straight there.
 */
export function TodoTabView({ todoId }: { todoId: string }) {
  // The pickers report whether they are open; a tab has no Escape-to-close or focus ring to yield.
  const [, setPickerOpen] = useState(false)
  return (
    <div data-testid="todo-tab-view" className="flex min-h-0 flex-1 flex-col gap-[var(--space-3)] overflow-y-auto px-[var(--space-4)] pb-[var(--space-5)] pt-[var(--space-3)]">
      <div className="flex flex-none items-center gap-[var(--space-1)]">
        <span className="font-[family-name:var(--font-code)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{todoId}</span>
        <span className="flex-1" />
        <Link
          to={todoPath(todoId)}
          aria-label={`Open ${todoId} full`}
          className="focus-ring grid size-7 flex-none place-items-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] outline-none transition-colors duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden />
        </Link>
      </div>
      <TodoPeek key={todoId} id={todoId} sheet={false} onPickerOpenChange={setPickerOpen} />
    </div>
  )
}
