import { useCallback, type ReactNode } from "react"
import { PageLayout } from "@/components/page-layout"
import { useOpenTodo } from "@/components/chat/file-open-context"
import { useFileLinkSession } from "@/components/chat/file-link-session-context"

/** What the Todo sits in: the app shell at its route, or a plain column filling a chat layout tab,
 *  whose pane already supplies the chrome. */
export function TaskFrame({ embedded, hideMobileTabBar, children }: {
  embedded: boolean
  hideMobileTabBar?: boolean
  children: ReactNode
}) {
  if (!embedded) return <PageLayout hideMobileTabBar={hideMobileTabBar}>{children}</PageLayout>
  return <div data-testid="todo-tab-view" className="flex h-full min-h-0 flex-1 flex-col">{children}</div>
}

/** Opens a Todo from a click; the click is passed so a tab opened elsewhere can keep it. */
export type OpenTodoFromClick = (id: string, event?: { stopPropagation(): void }) => void

/** Opening another Todo (an ancestor crumb, a sub-task) from a Todo shown as a tab opens it as a
 *  tab too, as a mention there does; where the layout cannot take one, and at the route, it is
 *  `navigate`. */
export function useOpenTodoInPlace(embedded: boolean, navigate: (id: string) => void): OpenTodoFromClick {
  const openTab = useOpenTodo()
  const sessionId = useFileLinkSession()
  return useCallback((id: string, event?: { stopPropagation(): void }) => {
    if (embedded && openTab?.(id, sessionId)) {
      // The pane the Todo sits in would take focus back on this click's way up, from the opened
      // Todo's tab where it is open in another pane.
      event?.stopPropagation()
      return
    }
    navigate(id)
  }, [embedded, openTab, sessionId, navigate])
}
