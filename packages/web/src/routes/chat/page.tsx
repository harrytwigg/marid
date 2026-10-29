import { useState, useCallback, useEffect, useRef, useMemo, Suspense, lazy } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { api } from '@/lib/api'
import {
  initialMobileView,
  parseSelectedSession,
  parseThreadOrigin,
  selectedDelegatedActivityFromList,
  sessionPath,
  threadOriginLabel,
  type ThreadOrigin,
} from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { useModelRegistry } from '@/hooks/use-model-registry'
import { useOrg } from '@/hooks/use-employees'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { newestVisibleSessionId } from '@/components/chat/session-sources'
import { NavRibbon } from '@/components/pill-nav'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import type { FreshChatSourceSession } from '@/components/chat/chat-pane'
import { cliUnavailableTitle, viewSwitchLockedEngine, viewSwitchLockedTitle } from '@/components/chat/chat-pane-title-bar'
import { ThreadPeek, type CommsPeekData } from '@/components/chat/thread-peek'
import { ChatErrorBoundary } from './chat-error-boundary'
import { ChatHeaderMenu } from './chat-header-menu'
import './glass-chat.css'
import { MultiChatGrid } from './multi-chat-grid'
import { deriveChatGridIds } from './grid-placement'
import { usePaneIdentity } from './pane-identity'
import { useChatPaneState } from './use-chat-pane-state'
import { historyRecord, parseHistoryPreview } from './chat-history'
import { SplitChatGrid, SplitDropOverlay, SplitGridContext, TODOS_TAB_ID, canCloseTab, closeAllUnpinned, focusedGroupTabs, hasTabbedGroup, hasUnpinnedTabs, holdsAfterClose, isChatTabId, isChatlessLayout, isPinned, loadsChatless, pinnedChats, selectTab, todosTabFocused, todosTabOpen, workingSetFromLayout, useSplitGridAdd, useSplitGridWorkspace } from './layout'
import { ChatPageHeader } from './chat-page-header'
import { SidebarColumn } from './sidebar-column'
import { formatMessage } from '@/components/chat/chat-messages'
import { inFileLinkSession } from '@/components/chat/file-link-session-context'
import { chatHeaderEmployee, chatHeaderEmployeeLine, chatHeaderTitle } from './header-title'
import { TODOS_TAB_TITLE } from './layout/tab-kind'
import { useMobileSessionTabs } from './use-mobile-session-tabs'
import { adjacentSessionId } from './session-navigation'
import { usePaneSessionActions } from './use-pane-session-actions'
import { useCopyFeedback } from './use-copy-feedback'
import { useSessionLifecycleActions } from './use-session-lifecycle-actions'
import { useChatTabSync } from './use-chat-tab-sync'
// Lazy so the file viewer's syntax-highlighter grammars + react-markdown are
// fetched only when a file tab is actually opened — not on the landing route.
const FileView = lazy(() =>
  import('@/components/chat/file-view').then((m) => ({ default: m.FileView })),
)
import { LayoutOpenProviders, type OpenFile } from '@/components/chat/file-open-context'
import { useEmployeeDeepLink, useNewChatTabHandlers, useNewChatTabOpener, useSubagentTabOpener, useTodoTabOpener } from './use-layout-tab-openers'
import { restoresPhoneTodos, usePhoneTodosHistory, useTodosTabPage } from './use-todos-tab-page'
import { fileBackPlan } from './file-back'
import { ShortcutOverlay } from '@/components/chat/shortcut-overlay'
import { useChatTabs, type ChatTab } from '@/hooks/use-chat-tabs'
import { invalidateLiveSessionSnapshot, prefetchLiveSessionSnapshot } from '@/hooks/use-live-session'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { buildShortcuts } from '@/lib/shortcut-catalog'
import { useDuplicateSession, useSessions } from '@/hooks/use-sessions'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import type { ViewMode } from '@/lib/view-mode'
import type { GatewayEvent } from '@jinn/gateway-events'
import { shareDebugLog, clearDebugLog } from '@/lib/debug-log'
import { buildFreshChatParams, effectivePrimaryProfile, startableProfileNames } from '@/components/chat/new-chat-helpers'
import { fetchFallbackChains } from '@/lib/api-fallback-chains'
import { buildContinuationPrompt } from '@/lib/stale-chat'
import { PRODUCT_NAME } from "@/lib/brand"
import { hasTodosOpenIntent } from '@/lib/todos-tab-entry'
import { setTodosTabFocused } from '@/lib/todos-tab-focus'
import { NavSurfaceProvider } from '@/components/nav-surface'
import { DocView } from '@/components/chat/doc-view'

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? PRODUCT_NAME
  const orgQuery = useOrg()
  const [pickedEmployee, setPickedEmployee] = useState<{ paneKey: string; employee: string | null } | null>(null)
  // The URL is the single source of truth for the selected session
  // (`/?session=<id>`) — selecting is a navigation, so browser back/forward
  // walk the session trail, refresh restores the thread, and links carry it.
  // A thread drill-in's history entry also carries its origin (the back chip);
  // Jinn ships in chrome-less Tauri shells, so every drill-in needs an in-app
  // way back while browser back keeps working on the web.
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const selectedId = useMemo(() => parseSelectedSession(location.search), [location.search])
  const threadOrigin = useMemo(() => parseThreadOrigin(location.state), [location.state])
  const selectedIdRef = useRef<string | null>(selectedId)
  const preservePaneFocusRef = useRef<string | null>(null)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  const entryIsTodosScreenRef = useRef(false)
  useEffect(() => { entryIsTodosScreenRef.current = restoresPhoneTodos(location.state) }, [location.state])
  // Router location updates are React TRANSITIONS (react-router wraps them in
  // startTransition), so our own urgent state (openTab, closeTab) can commit a
  // frame BEFORE the URL. While one of our navigations is in flight, the
  // tab→URL reconciler must stand down or it re-navigates against the stale
  // URL and clobbers the entry (state included). undefined = nothing pending.
  const pendingNavRef = useRef<string | null | undefined>(undefined)
  // Mobile opens on the THREAD when the URL already selects a session
  // (refresh / deep link / direct open) and on the LIST for bare `/` — the
  // pane derives from the URL at mount, not only from tap events.
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>(
    () => (restoresPhoneTodos(location.state) ? 'chat' : initialMobileView(location.search)),
  )
  // The phone shows the Todos tab on a screen of its own, which no layout focus can say: a chat opened
  // or a new chat started from there leaves it, and the layout has no tab to show instead.
  const [phoneTodos, setPhoneTodos] = useState(() => restoresPhoneTodos(location.state))
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [, setEmployeeSessions] = useState<Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  // Also the state of a page that opens on standalone tabs alone (the Todos tab), which has no chat to
  // auto-select: the newest chat stays closed, as it does once the last chat is closed beside that tab.
  const newChatIntentRef = useRef(loadsChatless(location.search, typeof window === 'undefined' ? null : window.localStorage))
  // A link to the Todos tab names no chat, and nothing the page would select belongs in front of it.
  if (!selectedId && hasTodosOpenIntent(location.search)) newChatIntentRef.current = true
  const [systemPrimedId, setSystemPrimedId] = useState<string | null>(null)
  // Employee to preselect for a brand-new chat (contacting a session-less
  // employee from the sidebar, or via an ?employee= deep-link). Null = none.
  const [pendingEmployee, setPendingEmployee] = useState<string | null>(null)
  const sessionsQuery = useSessions()
  // Which pane the route shows, when it may show it, and the optimistic bubble handed to the session the pane creates.
  const { paneKey, committedId, awaitingOpen, pendingMessage, paneSlotRef, revealSelection, adoptSession, startComposer } = usePaneIdentity(selectedId, pendingEmployee, { newChatIntent: newChatIntentRef.current, sessionsPending: sessionsQuery.isPending, sessionCount: sessionsQuery.data?.length ?? 0 })
  const { workingSet, gridPicker, gridState, releaseMobilePicker } = useSplitGridWorkspace(committedId, sessionsQuery.data, systemPrimedId)
  const { viewport, focusedSessionId, gridPaneKeys } = gridState
  const paneState = useChatPaneState(committedId, focusedSessionId)
  const sessionMeta = paneState.meta
  // Show-both: the slim nav ribbon is always mounted (desktop); only the chat
  // list folds. The ribbon's top toggle drives listOpen (persisted), so nav
  // never leaves the rail. There is no list⇄nav swap any more.
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('jinn-chat-list-open') !== 'false' } catch { return true }
  })
  const persistListOpen = useCallback((next: boolean) => {
    try { localStorage.setItem('jinn-chat-list-open', String(next)) } catch { /* ignore */ }
  }, [])
  const toggleList = useCallback(() => {
    setListOpen((prev) => { const next = !prev; persistListOpen(next); return next })
  }, [persistListOpen])
  // The edge's drag-to-collapse/reopen and the ribbon toggle share one persisted open state.
  const setListOpenFromDrag = useCallback((next: boolean) => {
    setListOpen((prev) => { if (prev === next) return prev; persistListOpen(next); return next })
  }, [persistListOpen])
  // Mobile: pop from the thread back to the chat list (the tab bar's Chat screen).
  const backToList = useCallback(() => { releaseMobilePicker(); setMobileView('sidebar') }, [releaseMobilePicker])
  const [threadPreview, setThreadPreview] = useState<CommsPeekData | null>(() => parseHistoryPreview(location.state))
  const previewHandoffTargetRef = useRef<string | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const previewSourceRef = useRef<{ sessionId: string | null; messageId: string; element: HTMLElement | null } | null>(null)
  const sessionScrollRef = useRef(new Map<string, number>())
  const returnFocusPendingRef = useRef(false)
  const destinationFocusPendingRef = useRef(false)

  const viewMode = paneState.viewMode
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const { copiedField, copiedPaneId, copyToClipboard, copyChat } = useCopyFeedback()
  const copyFromHeader = useCallback((text: string, field: string) => {
    copyToClipboard(text, field); setShowMoreMenu(false)
  }, [copyToClipboard])
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const { data: engineRegistry } = useModelRegistry() // PTY capability per engine — drives the CLI view toggle
  const chatTabs = useChatTabs()
  const removeWorkingSetPane = workingSet.remove
  const closeSessionTab = chatTabs.closeTabBySessionId
  // Bulk archive/delete removes many sessions at once. Per-id navigation is not
  // wanted (the operator is culling a list, not switching chats), but a pane or
  // tab still holding a removed session would go stale, so close each one; the
  // route follows the active tab if it was among them.
  //
  // A pane still showing a removed session can take focus after the removal (the composer's
  // focus after a switch lands a frame late), and focus selects the pane's chat: that reopened
  // the closed tab and pulled the route back. So the ids removed here are remembered until an
  // explicit selection opens one again, and a pane's own focus does not select them.
  const removedSessionIdsRef = useRef(new Set<string>())
  // The bulk archive can land between a select and the route committing it, so the
  // navigation in flight names a chat that is already gone. That commit is not a new
  // arrival: it must not clear the removed mark or open the tab back up.
  const overtakenSelectionRef = useRef<string | null>(null)
  const handleSessionsRemoved = useCallback((ids: string[]) => {
    for (const id of ids) {
      removedSessionIdsRef.current.add(id)
      if (pendingNavRef.current === id) overtakenSelectionRef.current = id
      removeWorkingSetPane(id); closeSessionTab(id)
    }
  }, [closeSessionTab, removeWorkingSetPane])
  const duplicateSessionMutation = useDuplicateSession()
  const focusedDelegatedActivity = useMemo(
    () => selectedDelegatedActivityFromList(sessionsQuery.data, focusedSessionId),
    [focusedSessionId, sessionsQuery.data],
  )
  const qc = useQueryClient()
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])


  // D4: open the existing global search (⌘K). GlobalSearch listens for a
  // meta/ctrl+K keydown on window, so synthesize one — same mechanism the old
  // header search button used. Desktop lost its only visible search entry when
  // the header became pills; this restores it inside the ⋯ menu.
  const openGlobalSearch = useCallback(() => {
    setShowMoreMenu(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
  }, [])

  // Update tab label/status when session meta changes.
  // Guarded by `sessionMeta.sessionId === selectedId` so we never cross-write
  // the previous session's meta onto the newly active tab during a switch
  // (a switch remounts ChatPane, which re-emits meta).
  const { updateTabStatus, closeTabBySessionId } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    if (sessionMeta.sessionId !== selectedId) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  // Subscribe to session lifecycle events so chat tabs reflect real-time
  // running/idle/error status, get their label updated on rename, and close
  // automatically when the underlying session is deleted (e.g. from sidebar
  // bulk-delete or another client). Without this, `status: 'running'` set by
  // handleSessionCreated never flips back, leaving a stale blue dot.
  useEffect(() => {
    const unsub = subscribe((frame: GatewayEvent) => {
      const { event, payload } = frame
      const p = (payload || {}) as { sessionId?: string; title?: string }
      const sid = p.sessionId
      if (!sid) return
      switch (event) {
        case 'session:started':
          updateTabStatus(sid, { status: 'running' })
          break
        case 'session:completed':
        case 'session:stopped':
          updateTabStatus(sid, { status: 'idle' })
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          break
        default:
          return
      }
      // Every event above changed the session, so its snapshot is dropped: one
      // that changed while no pane for it was mounted — a child that STARTED
      // while its peek was closed included — takes a cold fetch on the next
      // visit instead of trusting a stale snapshot. The MOUNTED pane is
      // unaffected: it heard the same event and rewrites its own snapshot.
      invalidateLiveSessionSnapshot(sid)
    })
    return unsub
  }, [subscribe, updateTabStatus, closeTabBySessionId])

  // Tabs follow the list's status and titles; a tab the list does not carry is looked up, not dropped.
  useChatTabSync(chatTabs, sessionsQuery.data as Parameters<typeof useChatTabSync>[1])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  // The single session-navigation helper — every selection funnels here
  // (sidebar, open-thread jumps, keyboard nav, tab shortcuts). User-initiated
  // selections PUSH a history entry; system-initiated callers (auto-select,
  // tab restore) pass `replace`. `from` is a drill-in's origin, carried in
  // history state for the back chip.
  const handleSelect = useCallback(
    (id: string, opts?: { navigateMobile?: boolean; replace?: boolean; from?: ThreadOrigin; system?: boolean }) => {
      removedSessionIdsRef.current.delete(id)
      // A fresh selection supersedes any archive that overtook an earlier one.
      overtakenSelectionRef.current = null
      const currentId = selectedIdRef.current
      const currentScroller = document.querySelector<HTMLElement>('.chat-messages-scroll') // display-toggled away on a phone, where it reports scrollTop 0
      if (currentId && currentScroller?.clientHeight) sessionScrollRef.current.set(currentId, currentScroller.scrollTop)
      newChatIntentRef.current = false; setSystemPrimedId(opts?.system ? id : null); releaseMobilePicker(); setPhoneTodos(false)
      // On mobile, opening a session pushes from the list into the thread, and the
      // pane arrives with it (see revealSelection). The one exception is the
      // background auto-select of the most-recent session (handleSessionsLoaded):
      // it primes selectedId for the desktop thread but must NOT drop a phone user
      // into a chat when they tapped the Chat tab — always the LIST (GRS-023).
      if (opts?.navigateMobile !== false) { revealSelection(id); setMobileView('chat') }
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
      // Skip when already selected — and dedupe PUSH re-fires while the same
      // navigation is still in flight (double-click, repeated auto-select).
      // REPLACE navigations pass through: they are idempotent, and the delete
      // routine pre-claims the sentinel before issuing its replace.
      if (id !== selectedIdRef.current && (opts?.replace || pendingNavRef.current !== id)) {
        pendingNavRef.current = id
        navigate(sessionPath(id), {
          replace: opts?.replace,
          state: opts?.from ? { from: opts.from } : undefined,
        })
      }
    },
    [chatTabs, navigate, releaseMobilePicker, revealSelection]
  )

  const handleFocusPane = useCallback((sessionId: string) => {
    workingSet.focus(sessionId)
    if (sessionId !== selectedIdRef.current) {
      preservePaneFocusRef.current = sessionId
      handleSelect(sessionId, { navigateMobile: false })
    }
  }, [handleSelect, workingSet])

  // Focus that reaches a pane itself, as opposed to a deliberate move to a chat (the next/previous
  // shortcut, closing a pane): a pane for a chat removed in bulk is not a selection.
  const handlePaneFocus = useCallback((sessionId: string) => {
    if (!removedSessionIdsRef.current.has(sessionId)) handleFocusPane(sessionId)
  }, [handleFocusPane])

  // A strip tab chosen is shown, as a chat chosen from the list is: from the Todos screen it is the way back to the chat.
  const handleMobileWorkingSetSelect = useCallback((sessionId: string) => {
    workingSet.split.show(sessionId)
    handleSelect(sessionId, { navigateMobile: false })
  }, [handleSelect, workingSet.split])

  const gridAdd = useSplitGridAdd(workingSet, selectedId, handleSelect, { primaryPaneKey: paneKey, committedSessionId: committedId, pickerPaneKey: gridPicker.paneKey, viewport })
  // URL → tab/intent sync: covers selections that did NOT come through
  // handleSelect — back/forward (POP), deep links, manual URL edits. openTab
  // dedupes and bails when already active, so re-running after a handleSelect
  // push is a no-op.
  const didMountRef = useRef(false)
  useEffect(() => {
    pendingNavRef.current = undefined
    if (navigationType === 'POP') setSystemPrimedId(null)
    // A commit the bulk archive overtook names a chat that is already gone, so it is
    // not an arrival: it must not clear the removed mark or open the tab back up.
    // The route follows the active tab instead — the step the tab→URL reconciler
    // would have taken had this commit not moved the URL out from under it. A POP is
    // never that push, so back/forward to the chat still re-opens it as before.
    const overtaken = overtakenSelectionRef.current
    overtakenSelectionRef.current = null
    if (selectedId && overtaken === selectedId && navigationType !== 'POP') {
      const at = chatTabs.activeTab
      didMountRef.current = true
      if (at && at.kind === 'session') {
        handleSelect(at.sessionId, { replace: true, navigateMobile: false, system: true })
      } else if (!at) {
        pendingNavRef.current = null
        navigate('/', { replace: true })
      }
      return
    }
    if (selectedId) {
      newChatIntentRef.current = false
      removedSessionIdsRef.current.delete(selectedId) // the route came to it again (back, deep link)
      chatTabs.openTab({ sessionId: selectedId, label: 'Loading...', status: 'idle', unread: false })
    } else if (didMountRef.current) {
      // Landed on bare `/` mid-session. On history traversal, arm the new-chat
      // intent so the auto-select can't hijack the back button — and on mobile,
      // "before any selection" means the chat LIST, so land there.
      if (navigationType === 'POP') {
        newChatIntentRef.current = true
        // An entry marked as the phone's Todos screen is that screen, not the list (usePhoneTodosHistory has taken it).
        if (!entryIsTodosScreenRef.current) setMobileView('sidebar')
      }
      chatTabs.clearActiveTab()
    }
    didMountRef.current = true
    // openTab/clearActiveTab are stable; depending on the whole chatTabs memo
    // would re-fire this on every tab mutation.
  }, [selectedId, navigationType, chatTabs.openTab, chatTabs.clearActiveTab])

  // Auto-focus the input on any session change (sidebar click, tab switch,
  // keyboard nav, "+ New"). The bump lands after ChatPane has settled, so it
  // reaches the ChatInput whether the pane remounted or adopted the session.
  useEffect(() => {
    if (previewHandoffTargetRef.current === selectedId) return
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return
    if (preservePaneFocusRef.current) {
      const shouldPreserve = preservePaneFocusRef.current === selectedId
      preservePaneFocusRef.current = null
      if (shouldPreserve) return
    }
    paneState.bumpFocus(selectedId)
  }, [paneState.bumpFocus, selectedId])

  const openNewChatInLayout = useNewChatTabOpener(workingSet.openNewChat, viewport.mobile)
  const handleNewChat = useCallback(() => {
    if (openNewChatInLayout(null)) return
    newChatIntentRef.current = true; releaseMobilePicker(); setPhoneTodos(false)
    startComposer()
    setPendingEmployee(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Leaving a session for the composer is a navigation — push, so back
    // returns to the thread you left. (The header names the composer, not a chat.)
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate, openNewChatInLayout, releaseMobilePicker, startComposer])

  // Start a new chat with a specific employee preselected — used when contacting
  // a session-less employee from the sidebar roster or via an ?employee= deep-link.
  // The actual session is created on first send (ChatPane → buildNewSessionParams).
  const contactEmployee = useCallback((name: string) => {
    if (openNewChatInLayout(name)) return
    newChatIntentRef.current = true; releaseMobilePicker(); setPhoneTodos(false)
    startComposer()
    setPendingEmployee(name)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
    // Contacting from within a session is a navigation to the composer — push.
    if (selectedIdRef.current) {
      pendingNavRef.current = null
      navigate('/')
    }
  }, [chatTabs, navigate, openNewChatInLayout, releaseMobilePicker, startComposer])

  // ?employee=<name> deep-link: an INTENT (compose to that employee), consumed once (use-layout-tab-openers).
  useEmployeeDeepLink(contactEmployee, !viewport.mobile && (!workingSet.hydrated || awaitingOpen) && !sessionsQuery.isError)

  // Back target for the phone file view's "back" button: the chat a file link
  // was clicked in. selectedIdRef is read at call time so the callback stays stable.
  const fileBackTargetRef = useRef<string | null>(null)

  // A chat file link, opened inside the app: on desktop as a tab beside the chat
  // that linked it (use-split-working-set openFile), on a phone as the full-screen
  // file view, whose back button returns to that chat. False sends the link to
  // its href, a new browser tab.
  const openFile = useCallback<OpenFile>((path, sessionId) => {
    if (!viewport.mobile) return workingSet.openFile(sessionId, { path, sessionId })
    fileBackTargetRef.current = selectedIdRef.current
    chatTabs.openFileTab(path, sessionId)
    setMobileView('chat')
    return true
  }, [chatTabs, viewport.mobile, workingSet])
  const openTodo = useTodoTabOpener(workingSet.openTodo, viewport.mobile)
  const openSubagent = useSubagentTabOpener(workingSet.openSubagent, viewport.mobile)
  // The Todos tab: opened or shown, the way back to a chat from it, and the phone's close of it.
  const newestChatId = useCallback(() => newestVisibleSessionId(sessionsQuery.data), [sessionsQuery.data])
  const { openTodosTab, showChat, closePhoneTodos } = useTodosTabPage({ workingSet, selectedIdRef, handleSelect, newestChatId, mobile: viewport.mobile, setMobileView, setPhoneTodos })

  // Mobile-only: back from the file view to the chat it was opened from (closing the
  // file tab, so they do not pile up into the open-chats cap), or to the chat list
  // when that chat's tab is gone. See fileBackPlan.
  const handleFileBack = useCallback(() => {
    const plan = fileBackPlan(chatTabs.tabs, chatTabs.activeIndex, fileBackTargetRef.current)
    if (!plan) return setMobileView('sidebar')
    if (plan.close !== null) chatTabs.closeTab(plan.close)
    chatTabs.switchTab(plan.switchTo)
    setMobileView('chat')
  }, [chatTabs])

  // A chat chosen from the list is the operator asking for that chat: shown even
  // where a file tab covers it, which focusing its pane or the URL landing on it
  // would keep in view.
  const handleOpenChat = useCallback((id: string) => {
    workingSet.split.show(id)
    handleSelect(id)
  }, [handleSelect, workingSet.split])

  const handleSessionsLoaded = useCallback(
    (sessions: { id: string }[]) => {
      if (!selectedId && !newChatIntentRef.current && sessions.length > 0) {
        // Background auto-select of the most-recent session: primes the desktop
        // thread, but stays on the chat LIST on mobile (navigateMobile: false),
        // so tapping the Chat tab opens the list to pick/start a chat. REPLACE —
        // a system pick must not create a history entry.
        handleSelect(sessions[0].id, { navigateMobile: false, replace: true, system: true })
      }
    },
    [selectedId, handleSelect]
  )

  // Delete/archive own the atomic fallback navigation and working-set cleanup.
  const {
    deleteSession: handleDeleteSession,
    archiveSession: handleArchiveSession,
    unarchiveSession: handleUnarchiveSession,
  } = useSessionLifecycleActions({
    selectedIdRef,
    pendingNavRef,
    sidebarOrderRef,
    sessionRows: sessionsQuery.data,
    tabs: chatTabs,
    navigate,
    selectSession: handleSelect,
    removePane: removeWorkingSetPane,
    setMenuOpen: setShowMoreMenu,
  })

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        // Opening the duplicate is a user navigation — push.
        pendingNavRef.current = result.id
        navigate(sessionPath(result.id))
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || 'Unknown error'}`)
    }
  }, [chatTabs, duplicateSessionMutation, qc, navigate])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])
  const paneSessionActions = usePaneSessionActions({ archive: handleArchiveSession, unarchive: handleUnarchiveSession, delete: handleDeleteSession, copyId: (sessionId) => copyToClipboard(sessionId, 'id', sessionId), duplicate: handleDuplicate, openBeside: gridPicker.open, setViewMode: paneState.setViewModeFor, copyCliResume: (sessionId, command) => copyToClipboard(command, 'cli', sessionId), shareDebugLog, clearDebugLog })

  const handleStartFreshChat = useCallback(async (previous: FreshChatSourceSession) => {
    const prompt = buildContinuationPrompt(previous.id)
    const employeeRemote = Boolean(previous.employee && orgQuery.data?.employees.find((e) => e.name === previous.employee)?.remoteHost)
    // Continue on the same Claude account, but only one confirmed still declared: a read that fails stops
    // the fresh chat rather than silently moving it to another login.
    let profile = previous.profile
    if (profile && !employeeRemote) {
      const chains = await qc.fetchQuery({ queryKey: queryKeys.fallbackChains(undefined), queryFn: () => fetchFallbackChains(), staleTime: 15_000 })
      profile = effectivePrimaryProfile({ profile, declared: startableProfileNames(chains) })
    }
    const result = await api.createSession(buildFreshChatParams({
      message: prompt,
      previous: { ...previous, profile },
      employeeRemote,
    }))
    const newSessionId = typeof result.id === 'string' ? result.id : ''
    if (!newSessionId) throw new Error('The gateway did not return a new session id')

    chatTabs.openTab({
      sessionId: newSessionId,
      label: typeof result.title === 'string' && result.title ? result.title : 'Continued Chat',
      status: 'running',
      unread: false,
      pinned: true,
      employeeName: previous.employee,
    })
    pendingNavRef.current = newSessionId
    navigate(sessionPath(newSessionId))
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, navigate, qc, orgQuery.data])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message, history: 'replace' | 'push' = 'replace') => {
    adoptSession(newId, pending)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    // REPLACE — the composer entry BECOMES the created session (same
    // conversation); back should skip the empty composer, not revisit it. A
    // new chat tab never had an entry (the route stayed on the chat it opened
    // over), so it pushes: back returns to that chat.
    pendingNavRef.current = newId
    navigate(sessionPath(newId), { replace: history === 'replace' })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [adoptSession, chatTabs, qc, navigate])
  const newChatTabs = useNewChatTabHandlers(workingSet, handleSessionCreated)

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref (declared with the URL model above) so this
  // callback stays stable.
  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  // Inline child affordances all request this one page-owned preview. The
  // same-URL history entry makes browser Back an honest close gesture; direct
  // sidebar/session selections continue through handleSelect without a preview.
  const sessionMetaRef = useRef(sessionMeta)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])
  const requestThreadPreview = useCallback((currentId: string, peek: CommsPeekData) => {
    const escapedSessionId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(currentId)
      : currentId.replace(/["\\]/g, '\\$&')
    const scroller = document.querySelector<HTMLElement>(
      `[data-chat-pane-session="${escapedSessionId}"] .chat-messages-scroll`,
    )
    if (currentId && scroller?.clientHeight) sessionScrollRef.current.set(currentId, scroller.scrollTop)
    previewSourceRef.current = {
      sessionId: currentId,
      messageId: peek.messageId,
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(peek)
    const existing = parseHistoryPreview(location.state)
    navigate(`${location.pathname}${location.search}`, {
      replace: Boolean(existing),
      state: { ...historyRecord(location.state), threadPreview: peek },
    })
  }, [location.pathname, location.search, location.state, navigate])

  const closeThreadPreview = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    if (parseHistoryPreview(location.state)) navigate(-1)
    else setThreadPreview(null)
  }, [location.state, navigate])

  const openPreviewFullChat = useCallback(async (childId: string) => {
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    try {
      await prefetchLiveSessionSnapshot(childId, controller.signal)
      if (controller.signal.aborted) return
      previewHandoffTargetRef.current = childId
      returnFocusPendingRef.current = true
      const parentId = selectedIdRef.current
      handleSelect(childId, {
        replace: true,
        from: parentId
          ? { id: parentId, label: threadOriginLabel(sessionMetaRef.current?.employee, portalName) }
          : undefined,
      })
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      throw error
    }
  }, [handleSelect, portalName])

  // Location state owns open/Back cancellation. A route committed by the
  // handoff is the one exception: keep the shell until that exact child paints.
  useEffect(() => {
    const historyPreview = parseHistoryPreview(location.state)
    if (historyPreview) {
      setThreadPreview(historyPreview)
      return
    }
    const target = previewHandoffTargetRef.current
    if (target && selectedId === target) return
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    previewHandoffTargetRef.current = null
    setThreadPreview(null)
  }, [location.state, selectedId])

  const handlePaneContentReady = useCallback((readyId: string) => {
    if (previewHandoffTargetRef.current === readyId) {
      previewAbortRef.current = null
      previewHandoffTargetRef.current = null
      destinationFocusPendingRef.current = true
      setThreadPreview(null)
      return
    }

    const source = previewSourceRef.current
    if (returnFocusPendingRef.current && source?.sessionId === readyId) {
      returnFocusPendingRef.current = false
      requestAnimationFrame(() => {
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(source.messageId)
          : source.messageId.replace(/["\\]/g, '\\$&')
        const target = source.element?.isConnected
          ? source.element
          : document.querySelector<HTMLElement>(`[data-source-message-id="${escaped}"] button, [data-block-id="${escaped}"]`)
        target?.focus({ preventScroll: true })
      })
    }
  }, [])

  const handlePreviewExited = useCallback(() => {
    if (!destinationFocusPendingRef.current) return
    destinationFocusPendingRef.current = false
    requestAnimationFrame(() => {
      if (window.innerWidth >= 1024 && focusedSessionId) paneState.bumpFocus(focusedSessionId)
      else document.querySelector<HTMLElement>('button[aria-label^="Back"]')?.focus({ preventScroll: true })
    })
  }, [focusedSessionId, paneState.bumpFocus])

  // The in-app way back for a drill-in: POP the entry the jump pushed (never
  // push a new one) — browser back and the chip walk the same trail.
  const goBackToOrigin = useCallback(() => navigate(-1), [navigate])
  const backTo = useMemo(
    () => (threadOrigin && selectedId ? { label: threadOrigin.label, onClick: goBackToOrigin } : undefined),
    [threadOrigin, selectedId, goBackToOrigin],
  )
  const backToFor = useCallback((sessionId: string) => sessionId === selectedId ? backTo : undefined, [backTo, selectedId])

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const target = adjacentSessionId(sidebarOrderRef.current.sessionIds, selectedId, direction)
    if (target) handleFocusPane(target)
  }, [selectedId, handleFocusPane])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  // Tab activation = session selection (pushes a history entry) for session
  // tabs; file tabs stay a pure tab-model switch (they live outside the URL).
  // Beside a visible strip the tab shortcuts act on that strip's tabs, not on the separate
  // open-chats list (use-chat-tabs), which holds one preview and the chats made here.
  const leaveRoute = useCallback(() => {
    // The beside-picker is a pane the layout does not hold, so emptying the layout leaves it
    // standing: close it here, on the desktop as well as the phone (releaseMobilePicker is a
    // no-op off mobile). Anything else and "the normal empty state" is two composers.
    gridPicker.close()
    startComposer()
    newChatIntentRef.current = true
    pendingNavRef.current = null
    setMobileView('sidebar')
    if (selectedIdRef.current) navigate('/')
  }, [gridPicker, navigate, startComposer])

  const handleRemovePane = useCallback((sessionId: string) => {
    // A pane's own close is the user's, and a pinned tab stays: a deleted session leaves through handleSessionsRemoved.
    if (isPinned(workingSet.split.layout, sessionId)) return
    const next = workingSet.afterRemove(sessionId)
    const standaloneLeft = holdsAfterClose(workingSet.split.layout, sessionId)
    workingSet.remove(sessionId)
    if (workingSet.state.focusedId !== sessionId) return
    if (next.focusedId) handleSelect(next.focusedId, { replace: true, navigateMobile: false })
    else if (standaloneLeft) leaveRoute() // only standalone tabs remain: the route has no chat to stay on
  }, [handleSelect, leaveRoute, workingSet])

  const groupTabs = useMemo(() => focusedGroupTabs(workingSet.split.layout), [workingSet.split.layout])
  // The strip's shown tab as the operator last chose it: the switch in flight, then the route. The
  // layout follows the URL a commit or more later, so a quick second key would otherwise act on the
  // tab the first one left.
  // A tab that is no chat is shown by the layout directly, never through the route, so nothing is in flight.
  const groupShownTab = useCallback((tabs: string[], active: string) => (
    !isChatTabId(active) ? active : [pendingNavRef.current, selectedIdRef.current].find((id): id is string => typeof id === 'string' && tabs.includes(id)) ?? active
  ), [])
  // A strip tab chosen by shortcut: shown, then the route follows its pane's chat (selectTab).
  const selectGroupTab = useCallback((tabId: string) => {
    selectTab(workingSet.split.layout, tabId, workingSet.split.show, handleSelect)
  }, [handleSelect, workingSet.split])
  const activateTab = useCallback((index: number) => {
    if (groupTabs) {
      const tabId = groupTabs.tabs[index]
      if (tabId) selectGroupTab(tabId)
      return
    }
    const target = chatTabs.tabs[index]
    if (!target) return
    if (target.kind === 'session') handleSelect(target.sessionId)
    else chatTabs.switchTab(index)
  }, [chatTabs, groupTabs, handleSelect, selectGroupTab])

  const cycleTab = useCallback((direction: 1 | -1) => {
    if (groupTabs) {
      const at = groupTabs.tabs.indexOf(groupShownTab(groupTabs.tabs, groupTabs.active))
      selectGroupTab(groupTabs.tabs[(at + direction + groupTabs.tabs.length) % groupTabs.tabs.length])
      return
    }
    const count = chatTabs.tabs.length
    if (count === 0) return
    activateTab((chatTabs.activeIndex + direction + count) % count)
  }, [chatTabs, groupTabs, groupShownTab, selectGroupTab, activateTab])

  // Centralized keyboard shortcut registry. SHORTCUT_CATALOG describes the keys
  // (and is what Settings lists); this map is the behaviour behind each one.
  const shortcuts = useMemo<ShortcutDef[]>(() => {
    const deleteSession = { action: () => { if (focusedSessionId && window.confirm('Delete this session?')) handleDeleteSession(focusedSessionId) }, enabled: !!focusedSessionId }
    return buildShortcuts({
      'new-chat': { action: handleNewChat },
      'next-session': { action: () => navigateSession(1) },
      'prev-session': { action: () => navigateSession(-1) },
      'next-employee': { action: cycleEmployee },
      'delete-session': deleteSession,
      'delete-session-forward': deleteSession,
      'copy-chat': { action: () => { if (focusedSessionId) void copyChat(focusedSessionId) }, enabled: !!focusedSessionId },
      'close-overlay': { action: () => { if (showShortcutOverlay) setShowShortcutOverlay(false); else if (showMoreMenu) setShowMoreMenu(false) } },
      'focus-chat': { action: () => document.querySelector<HTMLElement>('[data-chat-pane-active="true"] [data-chat-textarea]')?.focus() },
      'keyboard-shortcuts': { action: () => setShowShortcutOverlay(v => !v) },
      'close-tab': { action: () => {
        const shown = groupTabs ? groupShownTab(groupTabs.tabs, groupTabs.active) : null
        if (shown) { if (canCloseTab(workingSet.split.layout, shown)) handleRemovePane(shown) }
        else if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
      } },
      'prev-tab': { action: () => cycleTab(-1) },
      'next-tab': { action: () => cycleTab(1) },
      'toggle-chat-list': { action: toggleList },
      'toggle-chat-list-alias': { action: toggleList },
      'tab-1': { action: () => activateTab(0) },
      'tab-2': { action: () => activateTab(1) },
      'tab-3': { action: () => activateTab(2) },
      'tab-4': { action: () => activateTab(3) },
      'tab-5': { action: () => activateTab(4) },
      'tab-6': { action: () => activateTab(5) },
      'tab-7': { action: () => activateTab(6) },
      'tab-8': { action: () => activateTab(7) },
      'tab-9': { action: () => activateTab(8) },
    })
  }, [handleNewChat, navigateSession, cycleEmployee, copyChat, focusedSessionId, handleDeleteSession, showShortcutOverlay, showMoreMenu, chatTabs, toggleList, activateTab, cycleTab, groupTabs, groupShownTab, handleRemovePane, workingSet.split.layout])

  useKeyboardShortcuts(shortcuts)

  // Tab → URL reconciliation: tab restore on mount, ⌘W close fallout, and
  // orphan-tab drops land on the tab model first — reflect them into the URL
  // with REPLACE (system-initiated, not user navigation). Gated on hydration
  // so the pre-load empty tab list can't clobber a deep link, and on the
  // active tab OBJECT actually changing: when only the URL moved (back/
  // forward, deep link), the stale active tab must not drag the URL backwards
  // — the URL wins and the openTab sync above brings the tabs along.
  const prevActiveTabRef = useRef<ChatTab | null | undefined>(undefined)
  const prevSelectedForTabSyncRef = useRef(selectedId)
  useEffect(() => {
    if (!chatTabs.hydrated) return
    // One of our navigations is still in flight (location commits are lower-
    // priority transitions) — the URL is stale; reconciling now would drag it
    // backwards. The effect re-runs when the navigation lands (selectedId dep).
    if (pendingNavRef.current !== undefined) return
    const at = chatTabs.activeTab
    const tabChanged = prevActiveTabRef.current === undefined || prevActiveTabRef.current !== at
    const urlMoved = prevSelectedForTabSyncRef.current !== selectedId
    prevActiveTabRef.current = at
    prevSelectedForTabSyncRef.current = selectedId
    // On the run where the URL itself moved, tabs FOLLOW the URL (the openTab
    // sync above lands next flush) — never the other way. Without this, a
    // fresh selection landing while its tab is still being opened (e.g. the
    // post-delete neighbour fallback, whose old tab was just closed) would be
    // bounced to '/' by the no-active-tab branch below.
    if (!tabChanged || urlMoved) return

    // A route on no chat by intent (a page opened on the Todos tab, a composer asked for) is not dragged to the
    // open-chats list's last chat.
    const noChatByIntent = !selectedId && newChatIntentRef.current
    if (at && at.kind === 'session' && at.sessionId !== selectedId && !noChatByIntent) {
      handleSelect(at.sessionId, { replace: true, navigateMobile: false, system: true })
      return
    }

    if (!at && selectedId && !newChatIntentRef.current) {
      setEmployeeSessions([])
      pendingNavRef.current = null
      navigate('/', { replace: true })
    }
    // When at.kind === 'file', leave selectedId untouched — we render FileView
    // instead of ChatPane, but the underlying session selection is preserved.
  }, [chatTabs.hydrated, chatTabs.activeTab, selectedId, handleSelect, navigate])

  const cliModeAvailable = !sessionMeta?.engine || engineRegistry?.engines?.[sessionMeta.engine]?.supportsPty === true
  const activeSessionTab = chatTabs.activeTab?.kind === 'session' ? chatTabs.activeTab : null
  const viewSwitchLocked = viewSwitchLockedEngine(sessionMeta?.engine, engineRegistry) && activeSessionTab?.sessionId === focusedSessionId && activeSessionTab.status === 'running'
  const cliTitle = viewSwitchLocked
    ? viewSwitchLockedTitle(sessionMeta?.engine)
    : cliModeAvailable ? undefined : cliUnavailableTitle(engineRegistry)
  const effectiveViewMode: ViewMode = cliModeAvailable ? viewMode : 'chat'

  /**
   * Everything a close-all does apart from emptying the phone's own strip, which that strip's
   * button does itself: its store belongs to the hook below, built before this page can hold a
   * handler that clears it. Landing on the bare route is the app's empty state, and the intent
   * mark is what stops the sidebar's auto-select from opening the newest chat straight back up in
   * place of what was just closed. Closing a tab abandons a new chat's draft, as single-tab close
   * already does, so nothing here asks first: it would be the only close that does, and no chat is
   * destroyed.
   */
  const closeAllWorkspace = useCallback(() => {
    // Pinned tabs stay (the layout keeps them, and so does the open-chats list for the pinned chats);
    // the route goes to the chat left standing when its own went, and the empty state is for when none is.
    const kept = closeAllUnpinned(workingSet.split.layout)
    const route = workingSetFromLayout(kept).focusedId
    if (!todosTabOpen(kept)) setPhoneTodos(false)
    workingSet.split.closeAll()
    chatTabs.closeAllTabs(pinnedChats(kept))
    if (route) {
      gridPicker.close()
      if (route !== selectedIdRef.current) handleSelect(route, { replace: true, navigateMobile: false })
      return
    }
    leaveRoute()
  }, [chatTabs, gridPicker, handleSelect, leaveRoute, workingSet.split])

  // The phone's Todos screen: the tab opened from the strip, the bottom bar or a link, and the list not in front of it.
  const phoneTodosShown = viewport.mobile && phoneTodos && mobileView === 'chat' && (todosTabOpen(workingSet.split.layout) || !workingSet.hydrated)
  usePhoneTodosHistory(phoneTodosShown, viewport.mobile, { setPhoneTodos, setMobileView })
  // The pane that holds focus shows the Todos tab: its title is the tab's, and no chat's header actions apply.
  const todosFocused = viewport.mobile ? phoneTodosShown : todosTabFocused(workingSet.split.layout)
  // What lives outside the page (the voice assistant's snapshot) is told which tab is in front.
  useEffect(() => {
    setTodosTabFocused(todosFocused)
    return () => setTodosTabFocused(false)
  }, [todosFocused])
  // The phone's open-chat strip carries its own close-all, so it needs the reset above.
  const mobileTabs = useMobileSessionTabs({
    committedId, systemPrimedId, activeId: phoneTodosShown ? null : focusedSessionId, sessions: sessionsQuery.data,
    subscribe, connectionSeq, onSelect: handleMobileWorkingSetSelect, onCloseAll: closeAllWorkspace,
    layout: {
      pinned: workingSet.split.layout.pinned,
      todos: todosTabOpen(workingSet.split.layout) ? { active: phoneTodosShown, onSelect: openTodosTab, onClose: closePhoneTodos } : undefined,
    },
  })

  /** The desktop bars' close-all: the reset above, plus the phone's strip, which is written from
   *  the desktop too and would otherwise bring tabs back on the next phone visit. */
  const handleCloseAllTabs = useCallback(() => {
    mobileTabs.closeAll()
    closeAllWorkspace()
  }, [closeAllWorkspace, mobileTabs.closeAll])

  /** A bar only offers the close when there is something to close. */
  const canCloseAllTabs = hasUnpinnedTabs(workingSet.split.layout) || chatTabs.tabs.some((tab) => !(tab.kind === 'session' && isPinned(workingSet.split.layout, tab.sessionId)))

  const moreMenu = (
    <ChatHeaderMenu
      open={showMoreMenu}
      onOpenChange={setShowMoreMenu}
      selectedId={todosFocused ? null : focusedSessionId}
      sessionMeta={sessionMeta}
      openGlobalSearch={openGlobalSearch}
      effectiveViewMode={effectiveViewMode}
      cliModeAvailable={cliModeAvailable}
      viewSwitchLocked={viewSwitchLocked}
      cliTitle={cliTitle}
      setAndPersistViewMode={paneState.setViewMode}
      onDuplicate={handleDuplicate}
      duplicatePending={duplicateSessionMutation.isPending}
      onArchive={handleArchiveSession}
      onUnarchive={handleUnarchiveSession}
      onCopyToClipboard={copyFromHeader}
      onShareDebugLog={shareDebugLog}
      onClearDebugLog={clearDebugLog}
      onDeleteSession={handleDeleteSession}
      onOpenChatBeside={gridPicker.open}
    />
  )
  // The conversation title — slim inline (desktop) / centered nav bar (mobile).
  const headerEmployees = orgQuery.data?.employees
  const headerTitle = todosFocused ? TODOS_TAB_TITLE : chatHeaderTitle({ focusedSessionId, meta: sessionMeta, sessions: sessionsQuery.data, employees: headerEmployees })
  // A composer pane keeps its key through its first send, so the pick follows the chat it becomes until
  // the chat's own meta lands; any other pane's key retires it.
  const onComposerPane = paneKey.startsWith('__new__')
  const composerPick = !onComposerPane ? null : pickedEmployee?.paneKey === paneKey ? pickedEmployee.employee : pendingEmployee
  useEffect(() => { if (!onComposerPane) setPickedEmployee(null) }, [onComposerPane])
  const headerEmployee = chatHeaderEmployee({ focusedSessionId, meta: sessionMeta, sessions: sessionsQuery.data, employees: headerEmployees, portalName, picked: composerPick })
  const onMobileList = mobileView === 'sidebar'
  const pickerPane = gridPicker.bind(gridAdd.addPane, workingSet.add, handleSessionCreated)
  // Standalone tabs alone (no chat, no route composer): the panes carry their own identity, a lone one included.
  const chatless = !viewport.mobile && !committedId && isChatlessLayout(workingSet.split.layout)
  const desktopMultiPane = chatTabs.activeTab?.kind !== 'file' && !awaitingOpen && !viewport.mobile && (chatless || deriveChatGridIds({ sessionIds: gridPaneKeys, primaryPaneKey: paneKey, primarySessionId: committedId, pickerPaneKey: pickerPane?.paneKey }).length > 1 || hasTabbedGroup(workingSet.split.layout))
  return (
    <LayoutOpenProviders file={openFile} todo={openTodo} subagent={openSubagent} session={handleOpenChat} todos={openTodosTab}>
    <NavSurfaceProvider surface={todosFocused ? 'todos' : 'chat'} onShowChat={showChat}>
    <PageLayout chromeless>
      <div className="flex overflow-hidden h-full">
        {/* Desktop keeps the slim nav ribbon while its chat list folds.
            The ribbon remains outside the clipping column so its labels can
            escape over the thread, while the list itself reflows at a fixed
            width and never changes its internal measure during the fold.
            The sibling thread therefore owns the remaining width throughout. */}
        {!viewport.mobile && <div className="group/sidebar hidden h-full shrink-0 lg:flex">
          <NavRibbon listOpen={listOpen} onToggleList={toggleList} />
          <SidebarColumn open={listOpen} viewport={viewport} onOpenChange={setListOpenFromDrag}>
            <ChatSidebar
              selectedId={selectedId}
              onSelect={handleOpenChat}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onArchive={handleArchiveSession}
              onUnarchive={handleUnarchiveSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
              onContactEmployee={contactEmployee}
              onSessionsRemoved={handleSessionsRemoved}
              onOpenBeside={gridAdd.addPane}
            />
          </SidebarColumn>
        </div>}

        <div
          data-shell="sheet"
          className="chat-pills-layout relative min-w-0 flex-1 flex-col overflow-hidden bg-background flex"
          // Set exactly where the pills + scrim are drawn, so a CLI or terminal
          // view clears them there and nowhere else (JIN-2; rule at the foot).
          data-floating-header={desktopMultiPane ? undefined : ''}
        >
          {/* Single-pane content scrolls beneath the header scrim: a glass band from
              lg up on a fine pointer, today's solid fade otherwise (glass-identity.css). */}
          {!desktopMultiPane && <div
            aria-hidden data-chat-top-scrim data-chat-scrim-flat={effectiveViewMode === 'cli' ? '' : undefined}
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-[5] h-[var(--chat-top-scrim)]",
              onMobileList && "hidden lg:block",
            )}
          />}

          {/* Mobile keeps its nav chrome; multi-pane desktop moves identity into panes. */}
          <ChatPageHeader
            hideOnMobile={onMobileList}
            title={headerTitle} subtitle={todosFocused ? undefined : chatHeaderEmployeeLine(headerTitle, headerEmployee)} chatId={todosFocused ? TODOS_TAB_ID : focusedSessionId}
            backTo={backTo}
            onBack={backToList}
            onNew={handleNewChat}
            moreMenu={moreMenu}
            mobileWorkingSet={mobileTabs.strip}
            copiedField={desktopMultiPane ? null : copiedField}
            hideDesktop={desktopMultiPane}
          />

          {viewport.mobile && <div className={mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}>
            {/* Mobile: the chat list is the full-width body; the bottom tab bar
                (rendered below) is the persistent nav. */}
            <ChatSidebar
              variant="mobile"
              selectedId={selectedId}
              onSelect={handleOpenChat}
              onNewChat={handleNewChat}
              onDelete={handleDeleteSession}
              onArchive={handleArchiveSession}
              onUnarchive={handleUnarchiveSession}
              onDuplicate={handleDuplicateFromSidebar}
              onSessionsLoaded={handleSessionsLoaded}
              onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
              onOrderComputed={handleOrderComputed}
              onContactEmployee={contactEmployee}
              onSessionsRemoved={handleSessionsRemoved}
            />
          </div>}

          <div
            ref={paneSlotRef}
            data-chat-grid-drop-surface
            data-chat-grid-drop-state={gridAdd.drop.active ? 'eligible' : 'idle'}
            {...gridAdd.drop.handlers}
            className={cn(
            "relative flex-1 overflow-hidden flex flex-col",
            "mobile-working-set-thread",
            mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
          )}>
            {/* File tab → render the in-app file viewer inside the same bounded
                wrapper (so scrolling is contained). Otherwise the single ChatPane,
                handling new-chat (sessionId=null) and the selected session. See
                usePaneIdentity for what the key does and does not remount. */}
            {phoneTodosShown ? (
              <div data-testid="phone-todos" className={cn('flex min-h-0 flex-1 flex-col pb-[calc(49px+max(var(--safe-bottom),6px))]', mobileTabs.strip ? 'pt-[calc(var(--safe-top)+48px+var(--mobile-session-tabs-height))]' : 'pt-[calc(var(--safe-top)+48px)]')}>
                <DocView doc={{ kind: 'todos' }} />
              </div>
            ) : chatTabs.activeTab?.kind === 'file' ? (
              <Suspense fallback={<div className="flex-1" />}>
                <FileView path={chatTabs.activeTab.path} sessionId={chatTabs.activeTab.sessionId} embedded onBack={handleFileBack} />
              </Suspense>
            ) : awaitingOpen ? <div className="flex-1" /> : (
              <SplitGridContext.Provider value={{ split: workingSet.split, sessionForKey: gridAdd.sessionForKey, onCloseAll: canCloseAllTabs ? handleCloseAllTabs : undefined, onLeaveRoute: leaveRoute }}>
              <MultiChatGrid
                grid={SplitChatGrid}
                sessionIds={gridPaneKeys}
                focusedId={focusedSessionId}
                primary={{
                  paneKey,
                  sessionId: committedId,
                  pendingUserMessage: pendingMessage,
                  initialEmployee: committedId ? undefined : pendingEmployee,
                  onSessionCreated: handleSessionCreated,
                  onNewChatEmployeeChange: (employee) => setPickedEmployee({ paneKey, employee }),
                  onClose: () => { if (workingSet.state.focusedId) handleFocusPane(workingSet.state.focusedId) },
                  viewMode: effectiveViewMode,
                  focusTrigger: paneState.focusTriggerFor(committedId),
                  delegatedActivity: focusedDelegatedActivity,
                }}
                viewport={viewport}
                chatless={chatless}
                onFocus={handlePaneFocus}
                onRemove={handleRemovePane}
                metaById={paneState.metaById} sessionTitleFor={(id) => sessionsQuery.data?.find((session) => String(session.id ?? '') === id)?.title}
                runtime={{ portalName, subscribe, engineRegistry, connectionSeq, skillsVersion, events }}
                sessionActions={paneSessionActions}
                backToFor={backToFor}
                copiedSessionId={desktopMultiPane ? copiedPaneId : null}
                scrollTopFor={(sessionId) => sessionScrollRef.current.get(sessionId)}
                viewModeFor={paneState.viewModeFor}
                focusTriggerFor={paneState.focusTriggerFor}
                delegatedActivityFor={(sessionId) => selectedDelegatedActivityFromList(sessionsQuery.data, sessionId)}
                onMeta={paneState.updateMeta}
                onNewMeta={paneState.updateNewMeta}
                onPeek={requestThreadPreview}
                onNewChat={handleNewChat}
                onRefresh={handleRefresh}
                onContentReady={handlePaneContentReady}
                onStartFreshChat={handleStartFreshChat}
                pickerPane={pickerPane}
                newChat={newChatTabs}
              />
              </SplitGridContext.Provider>
            )}
            <SplitDropOverlay placement={gridAdd.drop.placement} />
          </div>

          {/* Stable above the session-keyed ChatPane: it survives route remount
              and releases only after the destination reports meaningful paint. */}
          <ThreadPeek
            peek={threadPreview}
            onClose={closeThreadPreview}
            onOpenFullChat={threadPreview?.sessionId ? openPreviewFullChat : undefined}
            onExited={handlePreviewExited}
            renderContent={(text) => inFileLinkSession(threadPreview?.sessionId, formatMessage(text))}
          />
        </div>
      </div>

      {/* Mobile bottom tab bar — persistent nav on the chat-list screen; hidden on
          the thread (Apple hidesBottomBarWhenPushed: the composer owns the bottom). */}
      {(onMobileList || phoneTodosShown) && <MobileTabBar />}

      {showShortcutOverlay && (
        <ShortcutOverlay
          shortcuts={shortcuts}
          onClose={() => setShowShortcutOverlay(false)}
        />
      )}

      {/* D8: clear the floating pills/scrim by padding the scroll container itself
          and aligning scroll anchoring to the same offset. Driven by the shared
          token (pill height + gap + safe-area) so it auto-tracks notched devices —
          no fragile `:first-child` coupling or magic number. Content still scrolls
          beneath the translucent scrim. A CLI or terminal view cannot scroll
          under it, so it starts below both (JIN-2): where the transcript's first
          message sits — this clearance plus its --chat-header-band — or the
          scrim's foot, whichever is lower (below lg the scrim outruns the band). */}
      <style>{`
        .chat-pills-layout .chat-messages-scroll {
          padding-top: var(--chat-top-clearance);
          scroll-padding-top: var(--chat-top-clearance);
        }
        .chat-pills-layout[data-floating-header] {
          --cli-terminal-top-inset: max(calc(var(--chat-top-clearance) + var(--chat-header-band)), var(--chat-top-scrim));
        }
      `}</style>
    </PageLayout>
    </NavSurfaceProvider>
    </LayoutOpenProviders>
  )
}
