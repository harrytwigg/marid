import type { DocTabRef } from '@/routes/chat/layout/tab-kind'

/** The test id of the view a document tab shows. */
export function docViewTestId(doc: DocTabRef): string {
  return doc.kind === 'file' ? 'pane-file-view' : doc.kind === 'todo' ? 'pane-todo-view' : 'pane-subagent-view'
}
