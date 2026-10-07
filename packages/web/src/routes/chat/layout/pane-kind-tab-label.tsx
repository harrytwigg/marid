import { FileText, ListTodo, SquarePen, type LucideIcon } from 'lucide-react'
import { useTodoPreview } from '@/lib/todo-preview'
import type { PaneTabKind } from './tab-kind'

type KindOfTab = Exclude<PaneTabKind, 'chat'>

const ICONS: Record<KindOfTab, LucideIcon> = { file: FileText, todo: ListTodo, 'new-chat': SquarePen }

/** The label of a tab that is no chat: its kind's glyph and its title (a file's basename in code type,
 * a Todo's id, then its title once the preview cache has it). */
export function PaneKindTabLabel({ kind, title, active }: { kind: KindOfTab; title: string; active: boolean }) {
  const Icon = ICONS[kind]
  return (
    <>
      <Icon size={12} strokeWidth={1.8} aria-hidden className={`shrink-0 ${active ? 'opacity-100' : 'opacity-50'}`} />
      <span data-pane-tab-title className={`min-w-0 flex-1 truncate ${kind === 'file' ? 'font-[family-name:var(--font-code)]' : ''}`}>
        {kind === 'todo' ? <TodoTabTitle todoId={title} /> : title}
      </span>
    </>
  )
}

function TodoTabTitle({ todoId }: { todoId: string }) {
  const title = useTodoPreview(todoId).data?.workItem.title
  return (
    <>
      <span data-pane-tab-number className="font-[family-name:var(--font-code)]">{todoId}</span>
      {title ? ` ${title}` : null}
    </>
  )
}
