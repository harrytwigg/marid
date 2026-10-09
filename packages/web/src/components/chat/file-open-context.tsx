import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { sessionPath } from '@/components/chat/chat-route-helpers'

/**
 * Opens a chat file link inside the app: as a tab beside the chat on desktop, as the file view
 * on a phone. Provided by the chat page. Returns false when it could not, so the link falls back
 * to its own href (a new browser tab); without a provider every link does.
 */
export type OpenFile = (path: string, sessionId: string | null) => boolean

export const FileOpenContext = createContext<OpenFile | null>(null)

export function useOpenFile(): OpenFile | null {
  return useContext(FileOpenContext)
}

/**
 * Opens a Todo mention inside the chat layout: as a tab beside the chat it was clicked in, on desktop.
 * Provided by the chat page. Returns false when it could not (a phone, a layout not yet loaded, no
 * chat on screen), so the mention falls back to its own href, the Todo's page; without a provider every one does.
 */
export type OpenTodo = (todoId: string, sessionId: string | null) => boolean

export const TodoOpenContext = createContext<OpenTodo | null>(null)

export function useOpenTodo(): OpenTodo | null {
  return useContext(TodoOpenContext)
}

/**
 * Opens a chat from a link anywhere inside the chat layout (a Todo shown as a tab, its session
 * links): the chat's tab is shown and its pane focused if it is already open, else it opens as it
 * does from the list. Provided by the chat page.
 */
export type OpenSession = (sessionId: string) => void

export const SessionOpenContext = createContext<OpenSession | null>(null)

/**
 * The one way a session link opens a chat. Inside the chat layout it shows the chat's existing tab
 * rather than navigating to the URL it already holds, which changes nothing while the chat is the
 * route's but sits behind another tab; outside it, it is the chat's route.
 */
export function useOpenSession(): OpenSession {
  const open = useContext(SessionOpenContext)
  const navigate = useNavigate()
  return useCallback((sessionId) => {
    if (open) open(sessionId)
    else void navigate(sessionPath(sessionId))
  }, [open, navigate])
}

/** The chat page's openers for what a link inside the layout can name: a file, a Todo, a chat. */
export function LayoutOpenProviders({ file, todo, session, children }: {
  file: OpenFile
  todo: OpenTodo
  session: OpenSession
  children: ReactNode
}) {
  return (
    <FileOpenContext.Provider value={file}>
      <TodoOpenContext.Provider value={todo}>
        <SessionOpenContext.Provider value={session}>{children}</SessionOpenContext.Provider>
      </TodoOpenContext.Provider>
    </FileOpenContext.Provider>
  )
}
