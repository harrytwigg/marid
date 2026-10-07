import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'
import type { PaneTitleDrag } from '@/components/chat/pane-tabs-context'
import { DocView } from '@/components/chat/doc-view'
import { fileTabTitle } from './file-tab'
import { PaneKindTabLabel } from './pane-kind-tab-label'
import type { DocTabRef } from './tab-kind'

/**
 * A pane that holds only documents: a file or a Todo dragged out of a chat's strip to its own side of
 * the grid. Its header is the strip when it holds more than one, else a plain title bar (as a lone
 * chat's pane has), which is what it is dragged back into a chat's strip by. The shown document fills
 * the rest, as it does over a chat.
 */
export function DocPane({ doc, header, active }: { doc: DocTabRef; header: ReactNode; active: boolean }) {
  return (
    <FileLinkSessionContext.Provider value={doc.kind === 'file' ? doc.file.sessionId : null}>
      <div data-testid={doc.kind === 'file' ? 'file-pane' : 'doc-pane'} data-doc-pane-kind={doc.kind} data-doc-pane-active={String(active)} className="group/doc-pane flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
        <div className={`flex h-[34px] shrink-0 items-stretch transition-colors duration-[var(--duration-fast)] ${active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}>{header}</div>
        <div data-testid={doc.kind === 'file' ? 'pane-file-view' : 'pane-todo-view'} className="relative flex min-h-0 flex-1 flex-col">
          <DocView doc={doc} />
        </div>
      </div>
    </FileLinkSessionContext.Provider>
  )
}

/** A lone document's title bar: its glyph and title, dragged like its tab would be, and a close button. */
export function DocPaneTitle({ doc, active, drag, onClose }: { doc: DocTabRef; active: boolean; drag: PaneTitleDrag; onClose: () => void }) {
  const title = doc.kind === 'file' ? fileTabTitle(doc.file.path) : doc.todoId
  return (
    <div
      data-testid="doc-pane-title"
      title={doc.kind === 'file' ? doc.file.path : undefined}
      {...drag}
      className={`flex min-w-0 flex-1 items-center gap-1.5 px-[8px] pl-[12px] text-[length:var(--text-subheadline)] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
    >
      <PaneKindTabLabel kind={doc.kind} title={title} active={active} />
      <button
        type="button"
        data-pane-focus-preserving
        aria-label={`Close ${title}`}
        onClick={(event) => { event.stopPropagation(); onClose() }}
        className="grid size-[26px] shrink-0 place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] opacity-0 transition-[color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/doc-pane:opacity-100"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
