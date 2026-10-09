import { lazy, Suspense } from 'react'
import type { DocTabRef } from '@/routes/chat/layout/tab-kind'

const FileView = lazy(() => import('@/components/chat/file-view').then((m) => ({ default: m.FileView })))
// The task page's own chunk, so the chat pays for it only once a Todo tab opens.
const TaskView = lazy(() => import('@/routes/todos/task-page/task-page').then((m) => ({ default: m.TaskView })))

/** A document tab's body, wherever it is shown: over its group's chat, or in a pane of its own. A Todo
 *  is the full Todo, as its page shows it. */
export function DocView({ doc }: { doc: DocTabRef }) {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      {doc.kind === 'todo'
        ? <TaskView key={doc.todoId} todoId={doc.todoId} embedded />
        : <FileView path={doc.file.path} sessionId={doc.file.sessionId} embedded />}
    </Suspense>
  )
}
