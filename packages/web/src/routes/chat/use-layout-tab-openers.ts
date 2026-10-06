import { useCallback, useMemo } from 'react'
import type { Message } from '@/lib/conversations'
import type { OpenTodo } from '@/components/chat/file-open-context'
import type { useSplitWorkingSet } from './layout/use-split-working-set'

type SplitWorkingSet = ReturnType<typeof useSplitWorkingSet>

/**
 * New chat as a tab of the layout, opened in the focused pane: a composer that can be dragged, split
 * and resized like any other tab. False (so the caller keeps the route's own composer) on a phone,
 * which has no split layout, or when the layout holds no chat to open it beside.
 */
export function useNewChatTabOpener(openNewChat: SplitWorkingSet['openNewChat'], mobile: boolean) {
  return useCallback((employee: string | null) => !mobile && openNewChat(employee), [mobile, openNewChat])
}

/**
 * A Todo mention opened as a tab beside the chat that mentions it. False on a phone, or with no chat
 * on screen to open it beside, which hands the click back to the mention's peek panel.
 */
export function useTodoTabOpener(openTodo: SplitWorkingSet['openTodo'], mobile: boolean): OpenTodo {
  return useCallback((todoId, sessionId) => !mobile && openTodo(sessionId, todoId), [mobile, openTodo])
}

/**
 * What a new chat tab's pane reports: its first send created a session, so the tab becomes that
 * chat's, in its slot, and the route moves to it as it does for the route's own composer; or it was
 * closed.
 */
export function useNewChatTabHandlers(workingSet: SplitWorkingSet, onSessionCreated: (sessionId: string, pending?: Message) => void) {
  const { remove, split } = workingSet
  return useMemo(() => ({
    onSessionCreated: (tabId: string, sessionId: string, pending?: Message) => {
      remove(tabId, sessionId)
      onSessionCreated(sessionId, pending)
    },
    onClose: split.close,
  }), [onSessionCreated, remove, split.close])
}
