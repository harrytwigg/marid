import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react'
import type { DocTabRef } from '@/routes/chat/layout/tab-kind'

const FileView = lazy(() => import('@/components/chat/file-view').then((m) => ({ default: m.FileView })))
// The task page's own chunk, so the chat pays for it only once a Todo tab opens.
const TaskView = lazy(() => import('@/routes/todos/task-page/task-page').then((m) => ({ default: m.TaskView })))

/** A document tab's body, wherever it is shown: over its group's chat, or in a pane of its own. A Todo
 *  is the full Todo, as its page shows it. */
export function DocView({ doc }: { doc: DocTabRef }) {
  const key = doc.kind === 'todo' ? `todo:${doc.todoId}` : `file:${doc.file.sessionId}:${doc.file.path}`
  return (
    // Keyed, so the next document shown here starts clean rather than inheriting a failure.
    <DocErrorBoundary key={key} kind={doc.kind}>
      <Suspense fallback={<div className="flex-1" />}>
        {doc.kind === 'todo'
          ? <TaskView todoId={doc.todoId} embedded />
          : <FileView path={doc.file.path} sessionId={doc.file.sessionId} embedded />}
      </Suspense>
    </DocErrorBoundary>
  )
}

/** A document that fails to load or render — a chunk gone stale after a deploy, or a throw in the
 *  view — fails in its own tab, and the chat beside it stays up. */
class DocErrorBoundary extends Component<{ kind: DocTabRef['kind']; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DocView]', error.message, '\nComponent stack:', info.componentStack)
  }
  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" data-testid="doc-view-error" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
          Couldn&apos;t show this {this.props.kind === 'todo' ? 'Todo' : 'file'}.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="focus-ring rounded-full px-4 py-2 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
        >
          Reload
        </button>
      </div>
    )
  }
}
