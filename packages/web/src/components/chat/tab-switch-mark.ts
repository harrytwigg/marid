import { useCallback, useEffect } from 'react'

/**
 * The chat a press on a phone tab brought forward, for as long as it stays in front. The thread's
 * crossfade and the nav-bar title's entrance are how a chat opens from the list; a tab press moves
 * between chats that are already open, and neither may play for it. Neither can tell a tab press
 * from a list tap on its own — the press is the only place that knows.
 *
 * It is keyed to the chat, not a flag, and it outlives the commit that showed the chat: the title
 * of a chat outside the session list arrives a fetch later, and that swap belongs to the same
 * switch. It ends the moment any other chat is in front. A press the page never acted on names a
 * chat that is not in front, so it can only ever affect that one chat's next arrival — and if that
 * chat is then opened from the list it opens silently, once. That gap is accepted: expiring an
 * unacted press would need a timer, and the page gives no signal that a navigation was dropped.
 */
let target: string | null = null

/** Read while the chat is being shown: did a tab press bring this chat forward? */
export function arrivesByTabSwitch(sessionId: string | null | undefined): boolean {
  return sessionId != null && target === sessionId
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
