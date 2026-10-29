import { ChevronLeft, X } from '@/components/ui/icon'
import { useEffect, useState } from 'react'
import { usePaneCloseAll, usePaneTabActions, usePaneTabsStrip, usePaneTitleDrag } from '@/components/chat/pane-tabs-context'
import { PaneTabMenu, TabUnpinButton } from '@/routes/chat/layout/pane-tab-controls'
import { CloseAllTabsButton } from '@/components/chat/close-all-tabs-button'
import { ChatPaneSessionMenu } from '@/components/chat/chat-pane-session-menu'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'
import { splitTitleId } from '@/components/chat/chat-tabs'
import { getStatusDot, StatusDot, type Session, useStallClock } from '@/components/chat/session-signals'
import type { BackgroundActivity, DelegatedActivity, EnginesResponse } from '@/lib/api'
import { emojiForName } from '@/lib/emoji-pool'
import { engineDisplayName } from '@/lib/engine-names'
import { isTerminalSession } from '@/lib/terminal-session'
import { TERMINAL_AVATAR } from '@/components/ui/employee-avatar'
import type { ViewMode } from '@/lib/view-mode'

const UUID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i

export function safePaneTitle(value: unknown): string | undefined {
  const title = typeof value === 'string' ? value.trim() : ''
  return title && !UUID_PATTERN.test(title) ? title : undefined
}

export function resolvePaneTitle(...values: unknown[]): string {
  return values.map(safePaneTitle).find(Boolean) ?? 'Chat'
}

function paneEmployee(current: unknown, fallback: unknown, portalName: string): string {
  return safePaneTitle(current) ?? safePaneTitle(fallback) ?? portalName.toLowerCase()
}

function paneStatus(current: unknown, running: boolean): string | undefined {
  if (running) return 'running'
  return typeof current === 'string' ? current : undefined
}

function paneDelegatedActivity(
  live: DelegatedActivity | null | undefined,
  current: DelegatedActivity | null | undefined,
): DelegatedActivity | null {
  return live === undefined ? current ?? null : live
}

export function paneTitleBarState(input: {
  sessionId: string | null
  currentSession: Record<string, unknown> | null
  loading: boolean
  turnPending: boolean
  backgroundActivity: BackgroundActivity | null
  delegatedActivity: DelegatedActivity | null | undefined
  paneTitle?: string
  paneEmployee?: string
  portalName: string
}): { title: string; employee: string; session: Session } {
  const current = (input.currentSession ?? {}) as Session
  return {
    title: resolvePaneTitle(input.currentSession?.title, input.paneTitle),
    employee: paneEmployee(input.currentSession?.employee, input.paneEmployee, input.portalName),
    session: {
      ...current,
      id: input.sessionId ?? 'new',
      status: paneStatus(input.currentSession?.status, input.loading || input.turnPending),
      backgroundActivity: input.backgroundActivity,
      delegatedActivity: paneDelegatedActivity(input.delegatedActivity, current.delegatedActivity),
    },
  }
}

/** Engines whose terminal and chat turns cannot share a session, so the view stays put while a turn runs. */
export function viewSwitchLockedEngine(engine: string | undefined, engineRegistry?: EnginesResponse): boolean {
  return engine !== undefined && engineRegistry?.engines?.[engine]?.ptyLockedDuringTurn === true
}

export function viewSwitchLockedTitle(engine: string | undefined): string {
  return `${engineDisplayName(engine ?? '')} view switching is locked while a turn is running`
}

/** Why the CLI view is off for an engine the registry does not (yet) offer it for. */
export function cliUnavailableTitle(engineRegistry?: EnginesResponse): string {
  return engineRegistry ? 'CLI view is not available for this engine' : 'Checking which engines offer a CLI view…'
}

function cliTitleFor(engine: string | undefined, locked: boolean, available: boolean, engineRegistry?: EnginesResponse): string | undefined {
  if (locked) return viewSwitchLockedTitle(engine)
  return available ? undefined : cliUnavailableTitle(engineRegistry)
}

/**
 * `turnRunning` is whether a turn is live now. It defaults to the session's status, which in a pane also
 * reads "running" for a turn that was stopped and never answered; a pane passes the live signal itself.
 */
export function paneViewControls(session: Session, engineRegistry?: EnginesResponse, turnRunning = session.status === 'running') {
  const engine = typeof session.engine === 'string' ? session.engine : undefined
  if (isTerminalSession(session)) return { cliModeAvailable: false, viewSwitchLocked: false, cliTitle: 'A terminal has no separate CLI view' }
  const cliModeAvailable = !engine || engineRegistry?.engines?.[engine]?.supportsPty === true
  const viewSwitchLocked = viewSwitchLockedEngine(engine, engineRegistry) && turnRunning
  return {
    cliModeAvailable,
    viewSwitchLocked,
    cliTitle: cliTitleFor(engine, viewSwitchLocked, cliModeAvailable, engineRegistry),
  }
}

interface ChatPaneTitleBarProps {
  active: boolean
  title: string
  employee: string
  session: Session
  backTo?: { label: string; onClick: () => void }
  /** Closes the pane's chat; without it the pane offers no close button. */
  onClose?: () => void
  sessionActions?: PaneSessionActions
  viewMode?: ViewMode
  cliModeAvailable?: boolean
  viewSwitchLocked?: boolean
  cliTitle?: string
}

/**
 * The close-all a pane with one tab carries: with no strip drawn, its title bar is that pane's whole
 * tab bar, so the action rides there. Only the focused pane offers it — a strip would have been that
 * pane's bar — so one bar carries it rather than every pane's.
 */
function PaneCloseAll({ active, hasStrip }: { active: boolean; hasStrip: boolean }) {
  const closeAll = usePaneCloseAll()
  if (hasStrip || !active || !closeAll) return null
  return <CloseAllTabsButton onClick={closeAll} />
}

function PaneTitleActions({ title, session, onClose, sessionActions, onRenamed, viewMode, cliModeAvailable, viewSwitchLocked, cliTitle, active, hasStrip }: Pick<ChatPaneTitleBarProps, 'title' | 'session' | 'onClose' | 'sessionActions' | 'viewMode' | 'cliModeAvailable' | 'viewSwitchLocked' | 'cliTitle'> & { onRenamed: (title: string) => void; active: boolean; hasStrip: boolean }) {
  const stallNow = useStallClock(session.status === 'running')
  const status = getStatusDot(session, new Set([session.id]), false, stallNow)
  return (
    <>
      <PaneCloseAll active={active} hasStrip={hasStrip} />
      <span data-testid="chat-pane-title-actions" className="group/title-actions relative flex h-full w-[52px] shrink-0 items-center justify-end">
        {sessionActions ? (
          <ChatPaneSessionMenu
            title={title}
            session={session}
            actions={sessionActions}
            onRenamed={onRenamed}
            viewMode={viewMode ?? 'chat'}
            cliModeAvailable={cliModeAvailable ?? false}
            viewSwitchLocked={viewSwitchLocked ?? false}
            cliTitle={cliTitle}
          />
        ) : null}
        {/* The dot gives way to the close button on hover; with no close button it stays. */}
        <span className={`grid size-[26px] place-items-center transition-opacity duration-[var(--duration-fast)] ${onClose ? 'group-hover/chat-pane:opacity-0 group-focus-within/title-actions:opacity-0' : ''}`}>
          {status ? <StatusDot data-testid="chat-pane-status-dot" color={status.color} pulse={status.pulse} title={status.label} className="size-2" /> : null}
        </span>
        {onClose ? <button
          type="button"
          data-pane-focus-preserving
          aria-label={`Close ${title}`}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className="absolute right-0 grid size-[26px] place-items-center rounded-[var(--radius-sm)] border-0 bg-[var(--bg)] text-[var(--text-secondary)] opacity-0 transition-[color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover/chat-pane:opacity-100 group-focus-within/title-actions:opacity-100"
        >
          <X size={14} aria-hidden />
        </button> : null}
      </span>
    </>
  )
}

/** A lone chat's label in its bar, where a strip's tab would be: its employee's emoji and its title, and the
 * pin glyph (which unpins it) when the tab is pinned. */
function LonePaneLabel({ active, employee, title, onUnpin }: { active: boolean; employee: string; title: string; onUnpin?: () => void }) {
  const { id, rest } = splitTitleId(title)
  return (
    <>
      <span
        aria-hidden
        data-chat-pane-emoji
        className={`shrink-0 leading-none transition-opacity duration-[var(--duration-fast)] ${active ? 'opacity-100' : 'opacity-50'}`}
      >
        {employee === TERMINAL_AVATAR ? '\u{1F5A5}\uFE0F' : emojiForName(employee)}
      </span>
      <span
        title={title}
        data-chat-pane-title
        className={`min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] transition-colors duration-[var(--duration-fast)] ${active ? 'font-[var(--weight-medium)] text-[var(--text-primary)]' : 'font-[var(--weight-regular)] text-[var(--text-tertiary)]'}`}
      >
        {id ? <span className={`transition-colors duration-[var(--duration-fast)] ${active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]'}`}>{id} </span> : null}
        <span>{rest}</span>
      </span>
      {onUnpin ? <TabUnpinButton title={title} onUnpin={onUnpin} /> : null}
    </>
  )
}

export function ChatPaneTitleBar({ active, title, employee, session, backTo, onClose, sessionActions, viewMode, cliModeAvailable, viewSwitchLocked, cliTitle }: ChatPaneTitleBarProps) {
  const [renamedTitle, setRenamedTitle] = useState<string>()
  useEffect(() => setRenamedTitle(undefined), [session.id, title])
  const visibleTitle = renamedTitle ?? title
  const tabs = usePaneTabsStrip(session.id)
  const drag = usePaneTitleDrag(session.id)
  const tabActions = usePaneTabActions(session.id)

  const bar = (
    <div
      data-testid="chat-pane-title-bar" data-chat-pane-titlebar={String(active)}
      {...drag}
      className={`flex h-[34px] shrink-0 items-center gap-2 px-[8px] pl-[12px] transition-colors duration-[var(--duration-fast)] ${active ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'}`}
    >
      {backTo ? (
        <button
          type="button"
          data-pane-focus-preserving
          aria-label={`Back to ${backTo.label}`}
          title={`Back to ${backTo.label}`}
          onClick={(event) => { event.stopPropagation(); backTo.onClick() }}
          className="inline-flex min-w-0 shrink-0 items-center gap-0.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-tertiary)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--text-primary)]"
        >
          <ChevronLeft size={14} aria-hidden className="shrink-0" />
          <span className="max-w-[90px] truncate">{backTo.label}</span>
        </button>
      ) : null}
      {tabs ?? <LonePaneLabel active={active} employee={employee} title={visibleTitle} onUnpin={tabActions?.pinned ? tabActions.unpin : undefined} />}
      <PaneTitleActions title={visibleTitle} session={session} onClose={onClose} sessionActions={sessionActions} onRenamed={setRenamedTitle} viewMode={viewMode} cliModeAvailable={cliModeAvailable} viewSwitchLocked={viewSwitchLocked} cliTitle={cliTitle} active={active} hasStrip={tabs !== null} />
    </div>
  )
  // With a strip the tabs carry their own menus; a lone tab's bar is its tab, so it carries this one.
  return tabs === null ? <PaneTabMenu actions={tabActions}>{bar}</PaneTabMenu> : bar
}
