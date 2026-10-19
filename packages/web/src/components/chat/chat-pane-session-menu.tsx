import { Ellipsis, ExternalLink, PanelRightOpen, Share2 } from '@/components/ui/icon'
import { useState } from 'react'
import { sessionUrl } from '@/components/chat/chat-route-helpers'
import { ViewModeItems } from '@/components/chat/view-mode-items'
import { SessionRowMenu, SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS, SESSION_MENU_SEPARATOR_CLASS } from '@/components/chat/session-row-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { Session } from '@/components/chat/session-signals'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'
import { openExternal } from '@/platform'
import type { ViewMode } from '@/lib/view-mode'

async function renamePane(title: string, sessionId: string, actions: PaneSessionActions, onRenamed: (title: string) => void): Promise<void> {
  const next = window.prompt('Rename chat', title)?.trim()
  if (!next || next === title) return
  onRenamed(next)
  try { await actions.rename(sessionId, next) } catch { onRenamed(title) }
}

interface ChatPaneSessionMenuProps {
  title: string
  session: Session
  actions: PaneSessionActions
  onRenamed: (title: string) => void
  viewMode: ViewMode
  cliModeAvailable: boolean
  viewSwitchLocked: boolean
  cliTitle?: string
}

function PaneMenuTrigger({ title }: Pick<ChatPaneSessionMenuProps, 'title'>) {
  return (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        data-pane-focus-preserving
        data-chat-pane-menu-trigger
        aria-label={`Actions for ${title}`}
        onClick={(event) => event.stopPropagation()}
        className="absolute left-0 grid size-[26px] place-items-center rounded-[var(--radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] opacity-0 transition-[color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 data-[menu-open]:opacity-100 group-hover/chat-pane:opacity-100 group-focus-within/title-actions:opacity-100"
      >
        <Ellipsis size={14} aria-hidden />
      </button>
    </DropdownMenuTrigger>
  )
}

function PaneViewControls({ session, actions, viewMode, cliModeAvailable, viewSwitchLocked, cliTitle, onChange }: Pick<ChatPaneSessionMenuProps, 'session' | 'actions' | 'viewMode' | 'cliModeAvailable' | 'viewSwitchLocked' | 'cliTitle'> & { onChange: (mode: ViewMode) => void }) {
  if (!actions.openBeside) return null
  return (
    <>
      <ViewModeItems viewMode={viewMode} cliModeAvailable={cliModeAvailable} viewSwitchLocked={viewSwitchLocked} cliTitle={cliTitle} onChange={onChange} />
      {/* Same labels and same slots as the header's More menu: the view toggle, then Open
          beside, then Open in new tab, then everything else. The pane title bar is the
          multi-pane home of actions the header owns in single-pane, so the two have to read
          alike. */}
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={actions.openBeside}>
        <PanelRightOpen aria-hidden />
        Open beside
      </DropdownMenuItem>
      <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => { void openExternal(sessionUrl(session.id)) }}>
        <ExternalLink aria-hidden />
        Open in new tab
      </DropdownMenuItem>
      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
    </>
  )
}

function PaneDeveloperItems({ session, actions }: Pick<ChatPaneSessionMenuProps, 'session' | 'actions'>) {
  const engineSessionId = typeof session.engineSessionId === 'string' ? session.engineSessionId : undefined
  const engine = typeof session.engine === 'string' ? session.engine : undefined
  if (!actions.copyCliResume && !actions.shareDebugLog && !actions.clearDebugLog) return null
  return (
    <>
      <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
      {engineSessionId && actions.copyCliResume ? (
        <DropdownMenuItem
          className={SESSION_MENU_ITEM_CLASS}
          onClick={() => {
            const cli = engine === 'codex' ? 'codex' : 'claude'
            actions.copyCliResume?.(session.id, `${cli} --resume ${engineSessionId}`)
          }}
        >
          Copy CLI Resume Command
        </DropdownMenuItem>
      ) : null}
      {actions.shareDebugLog ? (
        <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={actions.shareDebugLog}>
          <Share2 aria-hidden />
          Share debug log
        </DropdownMenuItem>
      ) : null}
      {actions.clearDebugLog ? (
        <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={actions.clearDebugLog}>
          Clear debug log
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

function PaneMenuContent({ title, session, actions, onRenamed }: Pick<ChatPaneSessionMenuProps, 'title' | 'session' | 'actions' | 'onRenamed'>) {
  return (
    <SessionRowMenu
      variant="dropdown"
      session={session}
      isPinned={actions.pinnedIds.has(session.id)}
      isArchived={Boolean(session.archivedAt)}
      onRename={() => { void renamePane(title, session.id, actions, onRenamed) }}
      onTogglePin={() => actions.togglePin(session.id)}
      onDuplicate={() => actions.duplicate(session.id)}
      onArchive={() => actions.archive(session.id, Boolean(session.archivedAt))}
      onStop={() => actions.stop(session.id)}
      onCopyId={() => actions.copyId(session.id)}
      beforeDelete={<PaneDeveloperItems session={session} actions={actions} />}
      onDelete={() => { if (window.confirm('Delete this session?')) actions.delete(session.id) }}
    />
  )
}

export function ChatPaneSessionMenu(props: ChatPaneSessionMenuProps) {
  const [open, setOpen] = useState(false)
  const changeViewMode = (mode: ViewMode) => {
    if (!props.viewSwitchLocked && (mode === 'chat' || props.cliModeAvailable)) {
      props.actions.setViewMode?.(props.session.id, mode)
      setOpen(false)
    }
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <PaneMenuTrigger title={props.title} />
      <DropdownMenuContent align="end" data-pane-focus-preserving onClick={(event) => event.stopPropagation()} className={SESSION_MENU_CONTENT_CLASS}>
        <PaneViewControls {...props} onChange={changeViewMode} />
        <PaneMenuContent {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
