import type { ComponentProps, ComponentType, ReactNode } from 'react'
import { ChatPane } from '@/components/chat/chat-pane'
import { resolvePaneTitle, safePaneTitle } from '@/components/chat/chat-pane-title-bar'
import { usePaneTabsShown } from '@/components/chat/pane-tabs-context'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'
import type { CommsPeekData } from '@/components/chat/thread-peek'
import type { DelegatedActivity } from '@/lib/api'
import type { ViewMode } from '@/lib/view-mode'
import { ChatGrid } from './chat-grid'
import { TERMINAL_AVATAR } from '@/components/ui/employee-avatar'
import { isTerminalSession } from '@/lib/terminal-session'
import { deriveChatGridIds } from './grid-placement'
import { isFileTabId } from './layout/file-tab'
import { useArrivedByTabSwitch } from '@/components/chat/tab-switch-mark'
import { SessionPicker } from './session-picker'
import type { SessionMeta } from './use-chat-pane-state'

type PaneProps = ComponentProps<typeof ChatPane>
type PaneMetaUpdate = Parameters<NonNullable<PaneProps['onSessionMetaChange']>>[0]
type PaneRuntime = Pick<PaneProps, 'portalName' | 'subscribe' | 'engineRegistry' | 'connectionSeq' | 'skillsVersion' | 'events'>

export { deriveChatGridIds } from './grid-placement'

interface MultiChatGridProps {
  sessionIds: string[]
  focusedId: string | null
  primary: {
    paneKey: string
    sessionId: string | null
    pendingUserMessage: PaneProps['pendingUserMessage']
    initialEmployee: PaneProps['initialEmployee']
    onSessionCreated: PaneProps['onSessionCreated']
    viewMode: ViewMode
    focusTrigger: number
    delegatedActivity: DelegatedActivity | null | undefined
    /** Closes a sessionless composer pane, which owns no working-set member. */
    onClose?: () => void
  }
  viewport: { width: number; height: number; mobile?: boolean }
  metaById: Record<string, SessionMeta>
  sessionTitleFor: (sessionId: string) => unknown
  runtime: PaneRuntime
  sessionActions?: PaneProps['sessionActions']
  backToFor?: (sessionId: string) => PaneProps['paneBackTo']
  copiedSessionId?: string | null
  scrollTopFor: (sessionId: string) => number | undefined
  viewModeFor: (sessionId: string) => ViewMode
  focusTriggerFor: (sessionId: string) => number
  delegatedActivityFor: (sessionId: string) => DelegatedActivity | null | undefined
  onFocus: (sessionId: string) => void
  onRemove: (sessionId: string) => void
  onMeta: (sessionId: string, meta: PaneMetaUpdate) => void
  onNewMeta: (meta: PaneMetaUpdate) => void
  onPeek: (sessionId: string, peek: CommsPeekData) => void
  onNewChat: PaneProps['onNewChat']
  onRefresh: PaneProps['onRefresh']
  onContentReady: PaneProps['onContentReady']
  onStartFreshChat: PaneProps['onStartFreshChat']
  pickerPane?: {
    paneKey: string
    onPick: (sessionId: string) => void
    onSessionCreated: NonNullable<PaneProps['onSessionCreated']>
    onClose: () => void
  }
  /** Lays the panes out in place of ChatGrid, with the same props (layout/split-chat-grid.tsx). */
  grid?: ComponentType<ComponentProps<typeof ChatGrid>>
}

function sessionForGridId(props: MultiChatGridProps, gridId: string): string | null {
  // A file-only pane's key is a file tab id: no session. The split grid handles those panes itself.
  if (isFileTabId(gridId)) return null
  if (gridId === props.primary.paneKey) return props.primary.sessionId
  return gridId === props.pickerPane?.paneKey ? null : gridId
}

function viewModeForPane(owner: MultiChatGridProps, sessionId: string | null, cliAvailable: boolean): ViewMode {
  if (!sessionId) return owner.primary.viewMode
  return cliAvailable ? owner.viewModeFor(sessionId) : 'chat'
}

function focusTriggerForPane(owner: MultiChatGridProps, sessionId: string | null): number {
  return sessionId ? owner.focusTriggerFor(sessionId) : owner.primary.focusTrigger
}

function delegatedActivityForPane(owner: MultiChatGridProps, sessionId: string | null) {
  return sessionId ? owner.delegatedActivityFor(sessionId) : owner.primary.delegatedActivity
}

function updatePaneMeta(owner: MultiChatGridProps, sessionId: string | null, update: PaneMetaUpdate): void {
  // The payload wins: a pane can change identity without remounting (composer
  // adoption), so the id captured in this closure may already be a step behind.
  const owningId = update.sessionId || sessionId
  if (owningId) owner.onMeta(owningId, update)
  else owner.onNewMeta(update)
}

function paneScrollTop(owner: MultiChatGridProps, sessionId: string | null): number | undefined {
  return sessionId ? owner.scrollTopFor(sessionId) : undefined
}

function panePeek(owner: MultiChatGridProps, sessionId: string | null): PaneProps['onPeek'] {
  return sessionId ? (peek) => owner.onPeek(sessionId, peek) : undefined
}

function paneCliAvailable(owner: MultiChatGridProps, sessionId: string | null): boolean {
  const engine = sessionId ? owner.metaById[sessionId]?.engine : undefined
  return !engine || owner.runtime.engineRegistry?.engines?.[engine]?.supportsPty === true
}

/** Who the pane's chrome says it is. A terminal session is known
 *  from list meta, so it renders as a terminal before its detail loads. */
function paneIdentity(owner: MultiChatGridProps, sessionId: string | null): Pick<PaneProps, 'terminal' | 'paneEmployee'> {
  if (!sessionId) return { terminal: false, paneEmployee: undefined }
  const meta = owner.metaById[sessionId]
  if (isTerminalSession(meta)) return { terminal: true, paneEmployee: TERMINAL_AVATAR }
  return { terminal: false, paneEmployee: safePaneTitle(meta?.employee) }
}

function titleForGridId(owner: MultiChatGridProps, gridId: string): string {
  const sessionId = sessionForGridId(owner, gridId)
  if (!sessionId) return gridId === owner.pickerPane?.paneKey ? 'Open chat' : 'New chat'
  return resolvePaneTitle(owner.metaById[sessionId]?.title, owner.sessionTitleFor(sessionId))
}

function removeGridPane(owner: MultiChatGridProps, gridId: string): void {
  if (gridId === owner.pickerPane?.paneKey) {
    owner.pickerPane.onClose()
    return
  }
  const sessionId = sessionForGridId(owner, gridId)
  if (sessionId) owner.onRemove(sessionId)
  // The composer pane has no session to remove: closing it hands the route back
  // to a live pane, which is what stops the grid reserving a composer slot.
  else if (gridId === owner.primary.paneKey) owner.primary.onClose?.()
}

function paneChrome(owner: MultiChatGridProps, sessionId: string | null): Pick<PaneProps, 'sessionActions' | 'paneBackTo' | 'copyNotice'> {
  return {
    sessionActions: owner.sessionActions,
    paneBackTo: sessionId ? owner.backToFor?.(sessionId) : undefined,
    copyNotice: Boolean(sessionId && owner.copiedSessionId === sessionId),
  }
}

function GridChatPane({
  gridId,
  active,
  owner,
  multiPane,
}: {
  gridId: string
  active: boolean
  owner: MultiChatGridProps
  multiPane: boolean
}) {
  const sessionId = sessionForGridId(owner, gridId)
  const tabbed = usePaneTabsShown()
  const primary = gridId === owner.primary.paneKey
  const pickerPane = gridId === owner.pickerPane?.paneKey ? owner.pickerPane : undefined
  const cliAvailable = paneCliAvailable(owner, sessionId)
  const pane = (
    <ChatPane
      {...owner.runtime}
      {...paneChrome(owner, sessionId)}
      sessionId={sessionId}
      initialScrollTop={paneScrollTop(owner, sessionId)}
      initialEmployee={primary ? owner.primary.initialEmployee : undefined}
      isActive={active}
      multiPane={multiPane || (tabbed && !owner.viewport.mobile)}
      {...paneIdentity(owner, sessionId)}
      paneTitle={titleForGridId(owner, gridId)}
      onClose={() => removeGridPane(owner, gridId)}
      onFocus={() => { if (sessionId) owner.onFocus(sessionId) }}
      onSessionCreated={primary ? owner.primary.onSessionCreated : pickerPane?.onSessionCreated}
      onNewChat={owner.onNewChat}
      onSessionMetaChange={(update) => updatePaneMeta(owner, sessionId, update)}
      onRefresh={owner.onRefresh}
      viewMode={viewModeForPane(owner, sessionId, cliAvailable)}
      focusTrigger={focusTriggerForPane(owner, sessionId)}
      pendingUserMessage={primary ? owner.primary.pendingUserMessage : undefined}
      onPeek={panePeek(owner, sessionId)}
      onContentReady={owner.onContentReady}
      delegatedActivity={delegatedActivityForPane(owner, sessionId)}
      onStartFreshChat={owner.onStartFreshChat}
      newChatEmptyState={pickerPane ? <SessionPicker onPick={pickerPane.onPick} /> : undefined}
    />
  )
  return (
    <FileLinkSessionContext.Provider value={sessionId}>
      {pane}
    </FileLinkSessionContext.Provider>
  )
}

function MobileThreadCrossfade({ paneId, children }: { paneId: string; children: ReactNode }) {
  return <MobileThreadFrame key={paneId} paneId={paneId}>{children}</MobileThreadFrame>
}

/** One per chat shown: the key above remounts it, and with it the grid, on every switch. The crossfade
 *  it carries plays when a chat opens; a tab press does not replay it (globals.css still describes it
 *  as replaying once per switch). */
function MobileThreadFrame({ paneId, children }: { paneId: string; children: ReactNode }) {
  // Latched at mount until the chat list is next shown, which hides the thread (see the hook).
  const byTabSwitch = useArrivedByTabSwitch(paneId)
  return (
    <div
      data-mobile-thread-pane={paneId}
      className={`flex min-h-0 flex-1 overflow-hidden ${byTabSwitch ? '' : 'animate-[jinn-mobile-chat-crossfade_var(--duration-base)_var(--ease-smooth)] motion-reduce:animate-none'}`}
    >
      {children}
    </div>
  )
}

function maybeCrossfadeMobileThread(mobile: boolean | undefined, paneId: string, grid: ReactNode): ReactNode {
  return mobile ? <MobileThreadCrossfade paneId={paneId}>{grid}</MobileThreadCrossfade> : grid
}

function focusedGridId(primaryKey: string, primarySessionId: string | null, focusedId: string | null): string {
  return !primarySessionId || focusedId === primarySessionId ? primaryKey : focusedId ?? primaryKey
}

export function MultiChatGrid(props: MultiChatGridProps) {
  const primaryKey = props.primary.paneKey
  const mobilePickerKey = props.viewport.mobile ? props.pickerPane?.paneKey : undefined
  const gridIds = deriveChatGridIds({
    sessionIds: props.sessionIds,
    primaryPaneKey: primaryKey,
    primarySessionId: props.primary.sessionId,
    pickerPaneKey: props.pickerPane?.paneKey,
    mobile: props.viewport.mobile,
  })
  const focusedGridIdValue = mobilePickerKey ?? focusedGridId(primaryKey, props.primary.sessionId, props.focusedId)

  const Grid = props.grid ?? ChatGrid
  const grid = (
    <Grid
      sessionIds={gridIds}
      focusedId={focusedGridIdValue}
      width={props.viewport.width}
      height={props.viewport.height}
      onFocus={(gridId) => {
        const sessionId = sessionForGridId(props, gridId)
        if (sessionId) props.onFocus(sessionId)
      }}
      renderPane={(gridId, active) => <GridChatPane gridId={gridId} active={active} owner={props} multiPane={gridIds.length > 1} />}
    />
  )
  return maybeCrossfadeMobileThread(props.viewport.mobile, focusedGridIdValue, grid)
}
