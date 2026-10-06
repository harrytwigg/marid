import { createContext, useContext } from 'react'

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
 * chat on screen), so the mention falls back to the peek panel; without a provider every one does.
 */
export type OpenTodo = (todoId: string, sessionId: string | null) => boolean

export const TodoOpenContext = createContext<OpenTodo | null>(null)

export function useOpenTodo(): OpenTodo | null {
  return useContext(TodoOpenContext)
}
