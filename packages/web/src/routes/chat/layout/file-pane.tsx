import { lazy, Suspense, type ReactNode } from 'react'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'
import type { FileTabRef } from './file-tab'

const FileView = lazy(() => import('@/components/chat/file-view').then((m) => ({ default: m.FileView })))

/**
 * A pane that holds only file tabs: a file dragged out of a chat's strip to its own side of the
 * grid. The strip is the pane's title bar, kept even for a lone file so it can be dragged back
 * into a chat's strip, and the shown file fills the rest, as it does over a chat.
 */
export function FilePane({ file, strip, active }: { file: FileTabRef; strip: ReactNode; active: boolean }) {
  return (
    <FileLinkSessionContext.Provider value={file.sessionId}>
      <div data-testid="file-pane" data-file-pane-active={String(active)} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--bg)]">
        <div className={`flex h-[34px] shrink-0 items-stretch transition-colors duration-[var(--duration-fast)] ${active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}>{strip}</div>
        <div data-testid="pane-file-view" className="relative flex min-h-0 flex-1 flex-col">
          <Suspense fallback={<div className="flex-1" />}>
            <FileView path={file.path} sessionId={file.sessionId} embedded />
          </Suspense>
        </div>
      </div>
    </FileLinkSessionContext.Provider>
  )
}
