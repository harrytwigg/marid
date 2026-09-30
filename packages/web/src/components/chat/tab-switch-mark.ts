import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/**
 * The chat a press on a phone tab brought forward, for as long as it stays in front. The thread's
 * crossfade and the nav-bar title's entrance are how a chat opens from the list; a tab press moves
 * between chats that are already open, and neither may play for it. Neither can tell a tab press
 * from a list tap on its own — the press is the only place that knows.
 *
 * It is keyed to the chat, not a flag, and it outlives the commit that showed the chat: the title
 * of a chat outside the session list arrives a fetch later, and that swap belongs to the same
 * switch. It ends the moment any other chat is in front, and the moment the chat list is: going
 * back to the list only hides the thread, so without that the chat in front would stay marked and
 * every reopen of it from the list would arrive silently. A press the page never acted on names a
 * chat that is not in front, so it can only affect that chat's next arrival before the list is
 * next shown — which, on the phone, every open from the list comes after.
 */
let target: string | null = null
/** How many times the list has stood in the thread's place: a thread frame outlives each one. */
let listVisits = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read while the chat is being shown: did a tab press bring this chat forward? */
export function arrivesByTabSwitch(sessionId: string | null | undefined): boolean {
  return sessionId != null && target === sessionId
}

/**
 * For the thread frame of a chat: `arrivesByTabSwitch` latched at mount, until the list is next shown.
 * Latched, because the mark can end while the frame is showing (the tabs hook drops it whenever its
 * active chat is not the marked one), and a class put back on a live element would start its
 * animation there and then. The list is the one exception: it hides the thread, so the class goes back on under
 * display:none, where it starts nothing, and plays when a tap in the list shows the thread again.
 */
export function useArrivedByTabSwitch(sessionId: string | null | undefined): boolean {
  const [atMount] = useState(() => ({ switched: arrivesByTabSwitch(sessionId), visits: listVisits }))
  const visits = useSyncExternalStore(subscribe, () => listVisits)
  return atMount.switched && visits === atMount.visits
}

/** The chat list standing in the thread's place ends the switch. */
export function useEndTabSwitchWhile(listShowing: boolean) {
  useEffect(() => {
    if (!listShowing) return
    target = null
    listVisits += 1
    listeners.forEach((listener) => listener())
  }, [listShowing])
}

/** A tab press: marks the switch, then hands the chat to the page. Pressing the tab in front is not a switch. */
export function useTabSwitchSelect(activeId: string | null, onSelect: (sessionId: string) => void) {
  // After the commit that put a chat in front: the mark stays only while that chat is the marked one.
  useEffect(() => {
    if (target !== activeId) target = null
  }, [activeId])
  return useCallback((sessionId: string) => {
    if (sessionId !== activeId) target = sessionId
    onSelect(sessionId)
  }, [activeId, onSelect])
}
