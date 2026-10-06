import { lazy, Suspense } from 'react'
import type { DocTabRef } from '@/routes/chat/layout/tab-kind'
import { TodoTabView } from '@/components/peek/todo-tab-view'

const FileView = lazy(() => import('@/components/chat/file-view').then((m) => ({ default: m.FileView })))

/** A document tab's body, wherever it is shown: over its group's chat, or in a pane of its own. */
export function DocView({ doc }: { doc: DocTabRef }) {
  if (doc.kind === 'todo') return <TodoTabView todoId={doc.todoId} />
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <FileView path={doc.file.path} sessionId={doc.file.sessionId} embedded />
    </Suspense>
  )
}
