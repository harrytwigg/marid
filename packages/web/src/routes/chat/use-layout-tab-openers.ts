import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Message } from '@/lib/conversations'
import { resolveDeepLink } from '@/components/chat/chat-route-helpers'
import type { OpenTodo } from '@/components/chat/file-open-context'
import type { useSplitWorkingSet } from './layout/use-split-working-set'

type SplitWorkingSet = ReturnType<typeof useSplitWorkingSet>

/**
 * New chat as a tab of the layout, opened in the focused pane: a composer that can be dragged, split
 * and resized like any other tab. False (so the caller keeps the route's own composer) on a phone,
 * which has no split layout, or when the layout holds no chat to open it beside.
 */
export function useNewChatTabOpener(openNewChat: SplitWorkingSet['openNewChat'], mobile: boolean) {
  return useCallback((employee: string | null) => {
    if (mobile || !openNewChat(employee)) return false
    // Ready to type, as the route composer is: the new chat's pane is the active one once it lands.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[data-chat-pane-active="true"] [data-chat-textarea]')?.focus()
    }))
    return true
  }, [mobile, openNewChat])
}

/**
 * A Todo mention opened as a tab beside the chat that mentions it. False on a phone, or with no chat
 * on screen to open it beside, which hands the click back to the mention's link to the Todo's page.
 */
export function useTodoTabOpener(openTodo: SplitWorkingSet['openTodo'], mobile: boolean): OpenTodo {
  return useCallback((todoId, sessionId) => !mobile && openTodo(sessionId, todoId), [mobile, openTodo])
}

/**
 * What a new chat tab's pane reports: its first send created a session, so the tab becomes that
 * chat's, in its slot, and the route moves to it as it does for the route's own composer, as a new
 * history entry; or it was closed. Opening the tab adds no entry, as opening a file tab adds none.
 */
export function useNewChatTabHandlers(workingSet: SplitWorkingSet, onSessionCreated: (sessionId: string, pending: Message | undefined, history: 'push') => void) {
  const { remove, split } = workingSet
  return useMemo(() => ({
    onSessionCreated: (tabId: string, sessionId: string, pending?: Message) => {
      remove(tabId, sessionId)
      // Opening the tab left the route (and history) on the chat it opened over: the new chat is a new entry.
      onSessionCreated(sessionId, pending, 'push')
    },
    onClose: split.close,
  }), [onSessionCreated, remove, split.close])
}

/**
 * The ?employee=<name> deep link: an INTENT (compose to that employee), not a location, so it is
 * consumed once and does not re-fire or stick. ?session= is never consumed: it IS the selection, and
 * resolveDeepLink's session-first precedence keeps a stray employee param inert beside it. While the
 * stored layout loads and a bare `/` settles on its chat (`waitForLayout`, desktop) the intent is held,
 * not dropped: the new chat may open as a tab of that layout, over that chat, and the route moving to
 * the chat takes the param with it.
 */
export function useEmployeeDeepLink(contactEmployee: (name: string) => void, waitForLayout: boolean) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [linked, setLinked] = useState<string | null>(null)
  useEffect(() => {
    const link = resolveDeepLink(searchParams)
    if (link?.kind !== 'employee') return
    setLinked(link.name)
    const next = new URLSearchParams(searchParams)
    next.delete('employee')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  useEffect(() => {
    if (!linked || waitForLayout) return
    setLinked(null)
    contactEmployee(linked)
  }, [contactEmployee, linked, waitForLayout])
}
