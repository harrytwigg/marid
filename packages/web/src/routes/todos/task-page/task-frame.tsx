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

/** Opening another Todo (an ancestor crumb, a sub-task) from a Todo shown as a tab opens it as a
 *  tab too, as a mention there does; where the layout cannot take one, and at the route, it is
 *  `navigate`. */
export function useOpenTodoInPlace(embedded: boolean, navigate: (id: string) => void): (id: string) => void {
  const openTab = useOpenTodo()
  const sessionId = useFileLinkSession()
  return useCallback((id: string) => {
    if (embedded && openTab?.(id, sessionId)) return
    navigate(id)
  }, [embedded, openTab, sessionId, navigate])
}
