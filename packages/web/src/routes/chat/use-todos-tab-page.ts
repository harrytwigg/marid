import { useCallback, useContext, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { UNSAFE_DataRouterContext, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { hasTodosOpenIntent } from '@/lib/todos-tab-entry'
import { historyRecord } from './chat-history'
import { routeChatForTodosOpen, TODOS_TAB_ID } from './layout'
import type { useSplitWorkingSet } from './layout/use-split-working-set'
import { useTodosOpenIntent } from './use-layout-tab-openers'

type SplitWorkingSet = ReturnType<typeof useSplitWorkingSet>

const PHONE_TODOS_KEY = 'phoneTodos'

/** Whether a history entry says the phone was on the Todos screen: it is the chat route's, whose address
 * cannot, and the screen has to come back when a Todo opened from it is left by the browser's back. */
export function restoresPhoneTodos(state: unknown): boolean {
  return historyRecord(state)[PHONE_TODOS_KEY] === true
}

/**
 * Keeps the current history entry's mark of the phone's Todos screen as the page has it (replace, no new entry),
 * and takes the screen from the entry the browser's back or forward arrives on (an entry marked is the screen, one
 * not is a chat).
 *
 * The mark is never written from a location that is being left. Under a data router a navigation is asynchronous
 * and a later one replaces the one pending, so a replace to the location this render still holds (a chat was chosen
 * in the same commit that left the screen) would put the page back where it came from. While the router holds a
 * navigation, or a location this render has not caught up with, the write waits: it comes round again when the
 * location lands. (A MemoryRouter navigates synchronously and has no such state.)
 */
export function usePhoneTodosHistory(
  shown: boolean,
  mobile: boolean,
  { setPhoneTodos, setMobileView }: { setPhoneTodos: Dispatch<SetStateAction<boolean>>; setMobileView: Dispatch<SetStateAction<'sidebar' | 'chat'>> },
) {
  const location = useLocation()
  const navigate = useNavigate()
  const router = useContext(UNSAFE_DataRouterContext)?.router
  const navigationType = useNavigationType()
  // Adjusted while rendering, so the commit that arrives on an entry never sees the screen it left (and marks the entry with it).
  const [arrivedKey, setArrivedKey] = useState(location.key)
  if (arrivedKey !== location.key) {
    setArrivedKey(location.key)
    if (mobile && navigationType === 'POP') {
      const marked = restoresPhoneTodos(location.state)
      setPhoneTodos(marked)
      if (marked) setMobileView('chat')
    }
  }
  useEffect(() => {
    // An address still carrying the open link is about to be rewritten by the page; writing over it now would put the link back.
    if (!mobile || restoresPhoneTodos(location.state) === shown || hasTodosOpenIntent(location.search)) return
    if (router && (router.state.navigation.state !== 'idle' || router.state.location.key !== location.key)) return
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: { ...historyRecord(location.state), [PHONE_TODOS_KEY]: shown } },
    )
  }, [location.hash, location.key, location.pathname, location.search, location.state, mobile, navigate, router, shown])
}

/**
 * The page's ways into and out of the Todos tab. Opening shows it where it is open, else opens it; the route
 * follows to the chat of the pane that takes it (routeChatForTodosOpen), and a phone, which has no panes,
 * shows it as a screen. `showChat` is the nav's Chat link while the tab is in front: the phone's chat list,
 * or a chat of the layout on the desktop, else the chat list's newest (false when there is none, leaving the link to do
 * what it does).
 */
export function useTodosTabPage({ workingSet, selectedIdRef, handleSelect, newestChatId, mobile, setMobileView, setPhoneTodos }: {
  workingSet: SplitWorkingSet
  selectedIdRef: MutableRefObject<string | null>
  handleSelect: (id: string, opts?: { navigateMobile?: boolean; replace?: boolean }) => void
  /** The chat list's newest chat, for a layout that holds none. */
  newestChatId: () => string | null
  mobile: boolean
  setMobileView: Dispatch<SetStateAction<'sidebar' | 'chat'>>
  setPhoneTodos: Dispatch<SetStateAction<boolean>>
}) {
  const { openTodosTab: openInLayout, split, state } = workingSet
  const openTodosTab = useCallback((): boolean => {
    const chat = routeChatForTodosOpen(split.layout)
    openInLayout()
    const moved = chat !== null && chat !== selectedIdRef.current
    if (moved) handleSelect(chat, { replace: true, navigateMobile: false })
    if (mobile) { setPhoneTodos(true); setMobileView('chat') }
    return moved
  }, [handleSelect, mobile, openInLayout, selectedIdRef, setMobileView, setPhoneTodos, split.layout])
  useTodosOpenIntent(openTodosTab, workingSet.hydrated)

  const showChat = useCallback((): boolean => {
    if (mobile) {
      setPhoneTodos(false)
      setMobileView('sidebar')
      return true
    }
    const inLayout = state.focusedId ?? state.sessionIds.at(-1)
    // A layout with no chat has none to show: the list's newest opens beside the tab, as the bare route does on a fresh load.
    const chat = inLayout ?? newestChatId()
    if (!chat) return false
    if (inLayout) split.show(chat)
    if (chat !== selectedIdRef.current || !inLayout) handleSelect(chat, { navigateMobile: false })
    return true
  }, [handleSelect, mobile, newestChatId, selectedIdRef, setMobileView, setPhoneTodos, split, state.focusedId, state.sessionIds])

  const closePhoneTodos = useCallback(() => {
    split.close(TODOS_TAB_ID)
    setPhoneTodos(false)
  }, [setPhoneTodos, split])
  return { openTodosTab, showChat, closePhoneTodos }
}
