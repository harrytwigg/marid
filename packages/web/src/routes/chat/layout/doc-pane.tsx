import type { ReactNode } from 'react'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'
import { usePaneCloseAll, type PaneTabActions, type PaneTitleDrag } from '@/components/chat/pane-tabs-context'
import { CloseAllTabsButton } from '@/components/chat/close-all-tabs-button'
import { DocView } from '@/components/chat/doc-view'
import { docViewTestId } from '@/components/chat/doc-view-test-id'
import { fileTabTitle } from './file-tab'
import { subagentTabTitle } from './subagent-tab'
import { PaneKindTabLabel } from './pane-kind-tab-label'
import { PaneTabMenu, PaneTitleTabButton } from './pane-tab-controls'
import { TODOS_TAB_TITLE, type DocTabRef } from './tab-kind'

/**
 * A pane that holds only documents: a file, a Todo or a sub-agent's conversation dragged out of a chat's strip to its own side of
 * the grid. Its header is the strip when it holds more than one, else a plain title bar (as a lone
 * chat's pane has), which is what it is dragged back into a chat's strip by. The shown document fills
 * the rest, as it does over a chat.
 */
export function DocPane({ doc, header, active }: { doc: DocTabRef; header: ReactNode; active: boolean }) {
  return (
    <FileLinkSessionContext.Provider value={doc.kind === 'file' ? doc.file.sessionId : null}>
      <div data-testid={doc.kind === 'file' ? 'file-pane' : 'doc-pane'} data-doc-pane-kind={doc.kind} data-doc-pane-active={String(active)} className="group/doc-pane flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
        <div className={`flex h-[34px] shrink-0 items-stretch transition-colors duration-[var(--duration-fast)] ${active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}>{header}</div>
        <div data-testid={docViewTestId(doc)} className="relative flex min-h-0 flex-1 flex-col">
          <DocView doc={doc} />
        </div>
      </div>
    </FileLinkSessionContext.Provider>
  )
}

function docTitle(doc: DocTabRef): string {
  if (doc.kind === 'file') return fileTabTitle(doc.file.path)
  if (doc.kind === 'todos') return TODOS_TAB_TITLE
  return doc.kind === 'todo' ? doc.todoId : subagentTabTitle(doc.subagent)
}

/** A lone document's title bar: its glyph and title, dragged like its tab would be, a close button (its
 * pin glyph, unpinning it, when pinned) and the tab's menu, since a lone tab has no strip to carry one. */
export function DocPaneTitle({ doc, active, drag, actions = null, onClose }: { doc: DocTabRef; active: boolean; drag: PaneTitleDrag; actions?: PaneTabActions | null; onClose: () => void }) {
  const title = docTitle(doc)
  // A lone document's pane shows no strip, so this bar is that pane's whole tab bar, as a lone
  // chat's is: the close-all belongs here for the same reason, and only when this pane has focus.
  const closeAll = usePaneCloseAll()
  return (
    <PaneTabMenu actions={actions}>
      <div
        data-testid="doc-pane-title"
        title={doc.kind === 'file' ? doc.file.path : undefined}
        {...drag}
        className={`flex min-w-0 flex-1 items-center gap-1.5 px-[8px] pl-[12px] text-[length:var(--text-subheadline)] ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
      >
        <PaneKindTabLabel kind={doc.kind} title={title} active={active} />
        {active && closeAll ? <CloseAllTabsButton onClick={closeAll} /> : null}
        <PaneTitleTabButton title={title} actions={actions} onClose={onClose} />
      </div>
    </PaneTabMenu>
  )
}
