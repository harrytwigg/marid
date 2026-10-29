import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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

/** Keeps the current history entry's mark of the phone's Todos screen as the page has it (replace, no new entry). */
export function usePhoneTodosHistory(shown: boolean, mobile: boolean) {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    // An address still carrying the open link is about to be rewritten by the page; writing over it now would put the link back.
    if (!mobile || restoresPhoneTodos(location.state) === shown || hasTodosOpenIntent(location.search)) return
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: { ...historyRecord(location.state), [PHONE_TODOS_KEY]: shown } },
    )
  }, [location.hash, location.pathname, location.search, location.state, mobile, navigate, shown])
}

/**
 * The page's ways into and out of the Todos tab. Opening shows it where it is open, else opens it; the route
 * follows to the chat of the pane that takes it (routeChatForTodosOpen), and a phone, which has no panes,
 * shows it as a screen. `showChat` is the nav's Chat link while the tab is in front: the phone's chat list,
 * or a chat of the layout on the desktop (false when there is none, leaving the link to do what it does).
 */
export function useTodosTabPage({ workingSet, selectedIdRef, handleSelect, mobile, setMobileView, setPhoneTodos }: {
  workingSet: SplitWorkingSet
  selectedIdRef: MutableRefObject<string | null>
  handleSelect: (id: string, opts?: { navigateMobile?: boolean; replace?: boolean }) => void
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
    const chat = state.focusedId ?? state.sessionIds.at(-1)
    if (!chat) return false
    split.show(chat)
    if (chat !== selectedIdRef.current) handleSelect(chat, { navigateMobile: false })
    return true
  }, [handleSelect, mobile, selectedIdRef, setMobileView, setPhoneTodos, split, state.focusedId, state.sessionIds])

  const closePhoneTodos = useCallback(() => {
    split.close(TODOS_TAB_ID)
    setPhoneTodos(false)
  }, [setPhoneTodos, split])
  return { openTodosTab, showChat, closePhoneTodos }
}
