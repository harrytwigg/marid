import type { ReactNode } from 'react'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'
import { DocView } from '@/components/chat/doc-view'
import type { DocTabRef } from './tab-kind'

/**
 * A pane that holds only documents: a file or a Todo dragged out of a chat's strip to its own side of
 * the grid. The strip is the pane's title bar, kept even for a lone document so it can be dragged back
 * into a chat's strip, and the shown document fills the rest, as it does over a chat.
 */
export function DocPane({ doc, strip, active }: { doc: DocTabRef; strip: ReactNode; active: boolean }) {
  return (
    <FileLinkSessionContext.Provider value={doc.kind === 'file' ? doc.file.sessionId : null}>
      <div data-testid={doc.kind === 'file' ? 'file-pane' : 'doc-pane'} data-doc-pane-kind={doc.kind} data-doc-pane-active={String(active)} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
        <div className={`flex h-[34px] shrink-0 items-stretch transition-colors duration-[var(--duration-fast)] ${active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}>{strip}</div>
        <div data-testid={doc.kind === 'file' ? 'pane-file-view' : 'pane-todo-view'} className="relative flex min-h-0 flex-1 flex-col">
          <DocView doc={doc} />
        </div>
      </div>
    </FileLinkSessionContext.Provider>
  )
}
