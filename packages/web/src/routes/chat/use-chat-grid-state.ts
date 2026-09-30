import { useEffect, useMemo, useState } from 'react'
import { overflowForViewport } from './grid-layout'
import { mobileWorkingSetIds } from './mobile-working-set-activity'
import { useChatTouchOrder, type ChatTouchOrder } from './use-chat-touch-order'
import { capWindowWidth, useSavedSidebarWidth } from './sidebar-width-store'
import { useChatViewport } from './use-chat-viewport'
import type { ChatWorkingSet } from './working-set'

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

export function useChatGridState({
  committedId,
  workingSet,
  sessions,
  pickerOpen = false,
  systemPrimedId = null,
}: {
  committedId: string | null
  workingSet: ChatWorkingSet
  sessions: ReadonlyArray<{ id?: unknown }> | undefined
  pickerOpen?: boolean
  systemPrimedId?: string | null
}) {
  const viewport = useChatViewport()
  const sidebarWidth = useSavedSidebarWidth()
  const touchOrder = useChatTouchOrder(committedId, sessions, systemPrimedId)
  // A URL selection can commit one render before working-set reconciliation.
  // Replace the primary member synchronously so both identities never mount.
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
  const reservedPaneSlots = !viewport.mobile
    ? Number(!committedId && workingSet.sessionIds.length > 0) + Number(pickerOpen)
    : 0
  const visibleWorkingSet = useMemo(() => overflowForViewport({
    ...workingSet,
    sessionIds: gridSessionIds,
    focusedId: focusedSessionId,
  }, capWindowWidth(viewport.width, sidebarWidth), viewport.height, reservedPaneSlots).visible, [focusedSessionId, gridSessionIds, reservedPaneSlots, sidebarWidth, viewport.height, viewport.width, workingSet])
  const mountedSessionIds = viewport.mobile
    ? (focusedSessionId ? [focusedSessionId] : [])
    : visibleWorkingSet.sessionIds
  const mobileSessionIds = useMobileSlots(visibleWorkingSet.sessionIds, sessions, focusedSessionId, touchOrder)
  return { viewport, gridSessionIds, focusedSessionId, mountedSessionIds, mobileSessionIds }
}
