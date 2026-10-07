import { useEffect, useMemo, useState } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatTouchOrder, type ChatTouchOrder } from './use-chat-touch-order'
import { capWindowWidth, useSavedSidebarWidth } from './sidebar-width-store'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'
import { isChatTabId } from './layout/tab-kind'
import { focusedGroup, groupOfSession, paneKeyOf, paneKeysFromLayout, type SplitLayout } from './layout/split-layout'

/**
 * The working set with the layout's panes that hold no chat in it (document-only panes, new chats), so
 * capacity and overflow count them: such a pane takes viewport like a chat. The chats keep their place
 * in tree order and a newcomer the URL has not landed in the layout yet goes last. With no such pane
 * it is `base`, untouched.
 */
export function withChatlessPanes(base: ChatWorkingSet, layout: SplitLayout | undefined): ChatWorkingSet {
  const paneKeys = layout ? paneKeysFromLayout(layout) : []
  if (!layout || paneKeys.every(isChatTabId)) return base
  const keys = paneKeys.filter((key) => !isChatTabId(key) || base.sessionIds.includes(key))
  // A chat a new chat's tab is shown over is held by that pane, not a newcomer to place.
  const sessionIds = [...keys, ...base.sessionIds.filter((id) => !keys.includes(id) && !groupOfSession(layout, id))]
  const focused = focusedGroup(layout)
  const focusedPane = focused ? paneKeyOf(focused, layout.focusHistory) : null
  const focusedId = focusedPane && !isChatTabId(focusedPane) ? focusedPane : base.focusedId
  // The route's chat (the working set's focused one) ranks just behind the focused pane, so a window too
  // small for every pane folds a chatless one before it.
  const route = base.focusedId && base.focusedId !== focusedId && sessionIds.includes(base.focusedId) ? base.focusedId : null
  const recent = [route, focusedId].filter((id): id is string => Boolean(id))
  const seen = layout.focusHistory.filter((id) => sessionIds.includes(id) && !recent.includes(id))
  const focusHistory = [...sessionIds.filter((id) => !seen.includes(id) && !recent.includes(id)), ...seen, ...recent]
  return { sessionIds, focusedId, focusHistory }
}

function useMobileSlots(
  memberIds: readonly string[],
  sessions: ReadonlyArray<{ id?: unknown }> | undefined,
  focusedSessionId: string | null,
  touchOrder: ChatTouchOrder,
): string[] {
  const [slots, setSlots] = useState<string[]>([])
  useEffect(() => {
    if (!touchOrder.hydrated) return
    setSlots((current) => {
      const next = mobileWorkingSetIds(memberIds, sessions ?? [], current, focusedSessionId, touchOrder.ids)
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next
    })
  }, [focusedSessionId, memberIds, sessions, touchOrder])
  return slots
}

function useVisibleWorkingSet(
  base: ChatWorkingSet,
  layout: SplitLayout | undefined,
  { width, height, reservedSlots }: { width: number; height: number; reservedSlots: number },
): ChatWorkingSet {
  return useMemo(
    () => overflowForViewport(withChatlessPanes(base, layout), width, height, reservedSlots).visible,
    [base, height, layout, reservedSlots, width],
  )
}

/**
 * A URL selection can commit one render before working-set reconciliation. Replace the primary
 * member synchronously so both identities never mount.
 */
function useShownSessions(committedId: string | null, workingSet: ChatWorkingSet) {
  const gridSessionIds = useMemo(() => {
    if (!committedId || workingSet.sessionIds.includes(committedId)) return workingSet.sessionIds
    if (workingSet.focusedId && workingSet.sessionIds.includes(workingSet.focusedId)) {
      return workingSet.sessionIds.map((id) => id === workingSet.focusedId ? committedId : id)
    }
    return [...workingSet.sessionIds, committedId]
  }, [committedId, workingSet.focusedId, workingSet.sessionIds])
  const focusedSessionId = committedId
    ? (!workingSet.sessionIds.includes(committedId) ? committedId : workingSet.focusedId ?? committedId)
    : null
  return { gridSessionIds, focusedSessionId }
}

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
  pickerOpen = false,
  systemPrimedId = null,
  layout,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  sessions: ReadonlyArray<{ id?: unknown }> | undefined
  pickerOpen?: boolean
  systemPrimedId?: string | null
  /** The split layout, for the panes with no chat it holds beyond the working set's chats. */
  layout?: SplitLayout
}) {
  const viewport = useChatViewport()
  const sidebarWidth = useSavedSidebarWidth()
  const touchOrder = useChatTouchOrder(committedId, sessions, systemPrimedId)
  const { gridSessionIds, focusedSessionId } = useShownSessions(committedId, workingSet)
  const reservedPaneSlots = !viewport.mobile
    ? Number(!committedId && workingSet.sessionIds.length > 0) + Number(pickerOpen)
    : 0
  const shownSet = useMemo(
    () => ({ ...workingSet, sessionIds: gridSessionIds, focusedId: focusedSessionId }),
    [focusedSessionId, gridSessionIds, workingSet],
  )
  const visibleWorkingSet = useVisibleWorkingSet(
    shownSet,
    layout,
    { width: capWindowWidth(viewport.width, sidebarWidth), height: viewport.height, reservedSlots: reservedPaneSlots },
  )
  // The chats on screen, and the panes (those chats and the panes with no chat) the grid mounts. A
  // phone shows one chat and no other pane.
  const visibleChatIds = useMemo(() => visibleWorkingSet.sessionIds.filter(isChatTabId), [visibleWorkingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleChatIds
  const gridPaneKeys = viewport.mobile ? mountedSessionIds : visibleWorkingSet.sessionIds
  const mobileSessionIds = useMobileSlots(visibleChatIds, sessions, focusedSessionId, touchOrder)
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, gridPaneKeys, mobileSessionIds }
}
