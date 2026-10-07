import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { capForViewport } from '../grid-layout'
import {
  WORKING_SET_STORAGE_KEY,
  persistWorkingSet,
  restoreWorkingSet,
} from '../working-set'
import {
  appendSession,
  closeSession,
  createPreviewLayout,
  createSplitLayout,
  emptySplitLayout,
  equalizeSplit,
  evictToCap,
  focusedGroup,
  focusGroupOfTab,
  focusSession,
  groupOfSession,
  groupsOf,
  materializeLayout,
  openDocTab,
  openNewChatTab,
  openInFocusedGroup,
  pinTab,
  placeTab,
  pruneSessions,
  replaceSession,
  setVisibleSplitSizes,
  showTab,
  workingSetFromLayout,
  type SplitLayout,
} from './split-layout'
import { loadSplitLayout, persistSplitLayout } from './split-layout-storage'
import { fileTabId, type FileTabRef } from './file-tab'
import { isChatTabId, isNewChatTabId, todoTabId } from './tab-kind'
import { forgetNewChatDraft } from '@/components/chat/use-chat-draft'
import { capWindowWidth, savedSidebarWidth } from '../sidebar-width-store'
import { applySplitDrop, type SplitDropContext } from './split-drop'
import type { SplitDropHit } from './split-geometry'

function viewportCap(): number {
  if (typeof window === 'undefined') return 4
  return capForViewport(capWindowWidth(window.innerWidth, savedSidebarWidth()), window.innerHeight)
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/**
 * The stored layout, unless the stored working set says otherwise. This layout writes both keys,
 * so they only disagree when something else wrote `jinn-chat-working-set` — an older build, the
 * upstream grid, a test seeding it — and then that list is the newer truth and the layout is
 * rebuilt from it, unarranged. An absent key is not a disagreement (cleared site data, a first
 * run): the layout stands, and neither is a session deleted since. The cap is left to
 * evictToCap so a window that shrank since does not count as disagreement either. Tabs of other
 * kinds are not sessions and are kept; they go with their group if every chat in it was deleted.
 */
export function hydrateSplitLayout(storage: Pick<Storage, 'getItem'>, liveIds: ReadonlySet<string>, cap: number): SplitLayout {
  const unpruned = loadSplitLayout(storage)
  const stored = pruneSessions(unpruned, (id) => liveIds.has(id))
  let raw: string | null = null
  try {
    raw = storage.getItem(WORKING_SET_STORAGE_KEY)
  } catch {
    // Unreadable storage is an absent key.
  }
  if (raw === null) return evictToCap(stored, cap)
  const upstream = restoreWorkingSet(raw, liveIds, Number.MAX_SAFE_INTEGER)
  // Compared before pruning, both sides through the same live filter: a group whose shown tab
  // was deleted while the page was closed now shows another tab, which the stored working set
  // never listed, and that is not a disagreement.
  const storedMembers = workingSetFromLayout(unpruned).sessionIds.filter((id) => liveIds.has(id))
  const agreed = sameOrder(storedMembers, upstream.sessionIds)
  const layout = agreed
    ? stored
    : { ...createSplitLayout(upstream.sessionIds, upstream.focusedId), focusHistory: upstream.focusHistory }
  return evictToCap(layout, cap)
}

const NO_IDS: ReadonlySet<string> = new Set()

/** The focused pane shows no chat (a document-only pane, a new chat's, a new chat shown over a chat):
 * the route may be on another pane's chat, and is not focused over it. */
function chatlessFocused(layout: SplitLayout): boolean {
  const focused = focusedGroup(layout)
  return focused !== null && !isChatTabId(focused.activeTab)
}

/** The chats the stored layout holds that the session list no longer does: deleted while the page
 * was closed, which is what hydration prunes them for. */
export function deletedWhileClosed(storage: Pick<Storage, 'getItem'>, liveIds: ReadonlySet<string>): ReadonlySet<string> {
  const dead = groupsOf(loadSplitLayout(storage)).flatMap((group) => group.tabs).filter((id) => isChatTabId(id) && !liveIds.has(id))
  return dead.length ? new Set(dead) : NO_IDS
}

export interface SplitLayoutControls {
  layout: SplitLayout
  /** Commits a splitter position for the children on screen (SplitHandle.childIds). `columns`
   * is the auto grid's, so an unarranged layout materializes into the same split ids its
   * handles were drawn from. */
  resize: (columns: number, splitId: string, childIds: string[], sizes: number[]) => void
  equalize: (columns: number, splitId: string) => void
  /** Tab-strip edits: put a tab in a group at a slot (adds, moves or re-orders), close a tab, keep a preview tab. */
  place: (groupId: string, sessionId: string, index: number) => void
  close: (sessionId: string) => void
  pin: (sessionId: string) => void
  /** Shows a tab in its group, file or chat; focusing a chat would keep a file shown over it. */
  show: (tabId: string) => void
  /** Focuses the pane holding a tab without changing the tab it shows (a pane with no chat). */
  focusPane: (tabId: string) => void
}

/**
 * The layout as shown: the URL's chat opened in it, ahead of the effect that commits that. A focused
 * pane showing no chat (a document-only pane, a new chat) may leave the route on another chat while
 * it holds focus: the chat the URL names is already in the layout, and is not focused over it.
 */
function useProjection(committedId: string | null, hydratedRef: { current: boolean }, deadRef: { current: ReadonlySet<string> }) {
  return useCallback((current: SplitLayout) => {
    if (!hydratedRef.current || !committedId || deadRef.current.has(committedId)) return current
    return chatlessFocused(current) && groupOfSession(current, committedId) ? current : openInFocusedGroup(current, committedId)
  }, [committedId, deadRef, hydratedRef])
}

/** A new chat tab's draft goes with the tab: closing it abandons the draft, as closing a browser tab
 * would, and a later tab minted with the same id (ids restart with an emptied layout) starts blank. */
function useForgetClosedNewChats(layout: SplitLayout) {
  const previous = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const open = new Set(groupsOf(layout).flatMap((group) => group.tabs).filter(isNewChatTabId))
    for (const tabId of previous.current) if (!open.has(tabId)) forgetNewChatDraft(tabId)
    previous.current = open
  }, [layout])
}

/** Hydrates once the session list is known, then lets the URL drive the focused pane, exactly
 * as use-chat-working-set.ts does; persists both keys from then on. */
function useLayoutSync(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
  layout: SplitLayout,
  setLayout: Dispatch<SetStateAction<SplitLayout>>,
) {
  const hydratedRef = useRef(false)
  // The open-chats list (use-chat-tabs) restores before the session list loads and can put a chat
  // deleted while the page was closed in the URL; opening it would lay that dead chat over the
  // survivor of its group. It is ignored until the URL moves on, so a later deliberate open works.
  // The chat the page was loaded on is always opened: the session list holds only the newest chats,
  // so an old one the operator reloaded on is missing from it without being deleted.
  const deadRef = useRef(NO_IDS)
  const loadedOnRef = useRef(committedId)
  useEffect(() => {
    if (!sessions || hydratedRef.current || typeof window === 'undefined') return
    const liveIds = new Set(sessions.map((session) => String(session.id ?? '')).filter(Boolean))
    if (loadedOnRef.current) liveIds.add(loadedOnRef.current)
    deadRef.current = deletedWhileClosed(window.localStorage, liveIds)
    let restored = hydrateSplitLayout(window.localStorage, liveIds, viewportCap())
    if (committedId && !deadRef.current.has(committedId)) {
      restored = groupsOf(restored).length === 0
        ? createPreviewLayout(committedId)
        : openInFocusedGroup(restored, committedId)
    }
    hydratedRef.current = true
    setLayout(restored)
  }, [committedId, sessions, setLayout])

  useEffect(() => {
    if (!hydratedRef.current || !committedId || deadRef.current.has(committedId)) return
    deadRef.current = NO_IDS
    setLayout((current) => openInFocusedGroup(current, committedId))
  }, [committedId, setLayout])

  // The URL selection lands in the layout from an effect, a commit after the grid already
  // shows it (use-chat-grid-state.ts substitutes it synchronously). Rendering from the
  // projected layout keeps that one commit from laying the newcomer out as a stray column.
  useForgetClosedNewChats(layout)
  const project = useProjection(committedId, hydratedRef, deadRef)
  const shown = useMemo(() => project(layout), [layout, project])
  const state = useMemo(() => workingSetFromLayout(shown), [shown])
  useEffect(() => {
    if (!hydratedRef.current || typeof window === 'undefined') return
    persistSplitLayout(window.localStorage, layout)
    persistWorkingSet(window.localStorage, workingSetFromLayout(layout))
  }, [layout])
  return { shown, state, project, hydrated: hydratedRef.current }
}

function useSplitControls(
  layout: SplitLayout,
  setLayout: Dispatch<SetStateAction<SplitLayout>>,
  project: (layout: SplitLayout) => SplitLayout,
): SplitLayoutControls {
  const resize = useCallback((columns: number, splitId: string, childIds: string[], sizes: number[]) => {
    setLayout((current) => setVisibleSplitSizes(materializeLayout(current, columns), splitId, childIds, sizes))
  }, [setLayout])
  const equalize = useCallback((columns: number, splitId: string) => {
    setLayout((current) => equalizeSplit(materializeLayout(current, columns), splitId))
  }, [setLayout])
  // On the layout as shown, which the strip predicted the placement on (pane-tab-ops place).
  const place = useCallback((groupId: string, sessionId: string, index: number) => {
    setLayout((current) => placeTab(project(current), groupId, sessionId, index))
  }, [project, setLayout])
  const close = useCallback((sessionId: string) => setLayout((current) => closeSession(current, sessionId)), [setLayout])
  const pin = useCallback((sessionId: string) => setLayout((current) => pinTab(current, sessionId)), [setLayout])
  const show = useCallback((tabId: string) => setLayout((current) => showTab(current, tabId)), [setLayout])
  const focusPane = useCallback((tabId: string) => setLayout((current) => focusGroupOfTab(current, tabId)), [setLayout])
  return useMemo(() => ({ layout, resize, equalize, place, close, pin, show, focusPane }), [close, equalize, focusPane, layout, pin, place, resize, show])
}

/** The page's openers for tabs other than the route's chat: a file or a Todo beside a chat, a new chat. */
function useTabOpeners(
  shown: SplitLayout,
  hydrated: boolean,
  project: (layout: SplitLayout) => SplitLayout,
  setLayout: Dispatch<SetStateAction<SplitLayout>>,
) {
  /** Opens a file preview as a tab beside `ownerSessionId`'s chat (else the focused one), on the
   *  layout as shown (the URL's chat in it). False when there is no chat on screen to open it
   *  beside, or the stored layout has yet to load over this one, so the caller can fall back: until
   *  the session list first loads (or if it never does) links open in a browser tab, as they did
   *  before file tabs, rather than land in a layout hydration is about to replace. */
  const openDoc = useCallback((ownerSessionId: string | null, tabId: string) => {
    if (!hydrated || (openDocTab(shown, ownerSessionId, tabId) === shown && !groupOfSession(shown, tabId))) return false
    setLayout((current) => openDocTab(project(current), ownerSessionId, tabId))
    return true
  }, [hydrated, project, shown])
  const openFile = useCallback((ownerSessionId: string | null, file: FileTabRef) => openDoc(ownerSessionId, fileTabId(file)), [openDoc])
  /** A Todo opened as a tab beside the chat that linked it, as openFile does for a file. */
  const openTodo = useCallback((ownerSessionId: string | null, todoId: string) => openDoc(ownerSessionId, todoTabId(todoId)), [openDoc])
  /** A new chat (addressed to `employee`, if given) as a tab of the focused pane. False when the layout
   *  holds no chat to open it beside, or has yet to load, so the caller falls back to the route's own
   *  composer. */
  const openNewChat = useCallback((employee: string | null) => {
    if (!hydrated || !groupsOf(shown).some((group) => group.tabs.some(isChatTabId))) return false
    setLayout((current) => openNewChatTab(project(current), employee))
    return true
  }, [hydrated, project, shown])

  return { openFile, openTodo, openNewChat }
}

/**
 * useChatWorkingSet's contract ({ state, add, focus, remove }) over the split layout, plus its
 * own controls, so the page's URL sync, eviction and phone path keep reading a working set
 * while the layout owns it.
 */
export function useSplitWorkingSet(
  committedId: string | null,
  sessions: Array<{ id?: unknown }> | undefined,
) {
  const [layout, setLayout] = useState<SplitLayout>(() => (
    committedId ? createPreviewLayout(committedId) : emptySplitLayout()
  ))
  const { shown, state, project, hydrated } = useLayoutSync(committedId, sessions, layout, setLayout)
  const split = useSplitControls(shown, setLayout, project)

  const add = useCallback((sessionId: string) => {
    setLayout((current) => evictToCap(appendSession(current, sessionId), viewportCap()))
  }, [])
  const focus = useCallback((sessionId: string) => {
    setLayout((current) => focusSession(current, sessionId))
  }, [])
  const remove = useCallback((sessionId: string, replacementId?: string | null) => {
    setLayout((current) => (replacementId ? replaceSession(current, sessionId, replacementId) : closeSession(current, sessionId)))
  }, [])
  const drop = useCallback((sessionId: string, hit: SplitDropHit, context: SplitDropContext) => {
    setLayout((current) => applySplitDrop(current, sessionId, hit, context))
  }, [])
  /** The working set once `sessionId` closes, for the page to follow focus. The upstream
   * prediction (removeWorkingSetSession on `state`) cannot see a group's hidden tabs, which is
   * what the pane falls back to. */
  const afterRemove = useCallback((sessionId: string) => workingSetFromLayout(closeSession(shown, sessionId)), [shown])
  const { openFile, openTodo, openNewChat } = useTabOpeners(shown, hydrated, project, setLayout)

  return { state, add, focus, remove, drop, split, afterRemove, openFile, openTodo, openNewChat, hydrated }
}
