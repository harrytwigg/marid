import { ChevronLeft, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePaneTabsStrip } from '@/components/chat/pane-tabs-context'
import { ChatPaneSessionMenu } from '@/components/chat/chat-pane-session-menu'
import type { PaneSessionActions } from '@/components/chat/pane-session-actions'
import { splitTitleId } from '@/components/chat/chat-tabs'
import { getStatusDot, StatusDot, type Session, useStallClock } from '@/components/chat/session-signals'
import type { BackgroundActivity, DelegatedActivity, EnginesResponse } from '@/lib/api'
import { emojiForName } from '@/lib/emoji-pool'
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

export function paneViewControls(session: Session, engineRegistry?: EnginesResponse) {
  const engine = typeof session.engine === 'string' ? session.engine : undefined
  if (isTerminalSession(session)) return { cliModeAvailable: false, viewSwitchLocked: false, cliTitle: 'A terminal has no chat view' }
  const cliModeAvailable = !engine || engineRegistry?.engines?.[engine]?.supportsPty === true
  const viewSwitchLocked = engine === 'codex' && session.status === 'running'
  return {
    cliModeAvailable,
    viewSwitchLocked,
    cliTitle: viewSwitchLocked
      ? 'Codex view switching is locked while a turn is running'
      : cliModeAvailable ? undefined : 'CLI view is not available for this engine',
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

function PaneTitleActions({ title, session, onClose, sessionActions, onRenamed, viewMode, cliModeAvailable, viewSwitchLocked, cliTitle }: Pick<ChatPaneTitleBarProps, 'title' | 'session' | 'onClose' | 'sessionActions' | 'viewMode' | 'cliModeAvailable' | 'viewSwitchLocked' | 'cliTitle'> & { onRenamed: (title: string) => void }) {
  const stallNow = useStallClock(session.status === 'running')
  const status = getStatusDot(session, new Set([session.id]), false, stallNow)
  return (
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
  )
}

export function ChatPaneTitleBar({ active, title, employee, session, backTo, onClose, sessionActions, viewMode, cliModeAvailable, viewSwitchLocked, cliTitle }: ChatPaneTitleBarProps) {
  const [renamedTitle, setRenamedTitle] = useState<string>()
  useEffect(() => setRenamedTitle(undefined), [session.id, title])
  const visibleTitle = renamedTitle ?? title
  const { id, rest } = splitTitleId(visibleTitle)
  const tabs = usePaneTabsStrip(session.id)

  return (
    <div
      data-testid="chat-pane-title-bar"
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
          <ChevronLeft size={14} strokeWidth={2.4} aria-hidden className="shrink-0" />
          <span className="max-w-[90px] truncate">{backTo.label}</span>
        </button>
      ) : null}
      {tabs ?? (
        <>
          <span
            aria-hidden
            data-chat-pane-emoji
            className={`shrink-0 leading-none transition-opacity duration-[var(--duration-fast)] ${active ? 'opacity-100' : 'opacity-50'}`}
          >
            {employee === TERMINAL_AVATAR ? '\u{1F5A5}\uFE0F' : emojiForName(employee)}
          </span>
          <span
            title={visibleTitle}
            data-chat-pane-title
            className={`min-w-0 flex-1 truncate text-[length:var(--text-subheadline)] transition-colors duration-[var(--duration-fast)] ${active ? 'font-[var(--weight-medium)] text-[var(--text-primary)]' : 'font-[var(--weight-regular)] text-[var(--text-tertiary)]'}`}
          >
            {id ? <span className={`transition-colors duration-[var(--duration-fast)] ${active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]'}`}>{id} </span> : null}
            <span>{rest}</span>
          </span>
        </>
      )}
      <PaneTitleActions title={visibleTitle} session={session} onClose={onClose} sessionActions={sessionActions} onRenamed={setRenamedTitle} viewMode={viewMode} cliModeAvailable={cliModeAvailable} viewSwitchLocked={viewSwitchLocked} cliTitle={cliTitle} />
    </div>
  )
}
