import { useEffect, useSyncExternalStore } from "react"
import { useLocation } from "react-router-dom"
import { queryClient } from "@/lib/query-client"
import { browserInstanceId } from "./browser-instance"
import { publishScreenContext } from "./page-context-store"
import { getTodosTabFocused, subscribeTodosTabFocused } from "@/lib/todos-tab-focus"
import { readTodosTabLocation, subscribeTodosTabLocation } from "@/routes/todos/board/todos-tab-location"
import { describeScreenLocation } from "./todos-tab-snapshot"
import { buildScreenContext } from "./surface-adapters"

const SETTLE_MS = 80

/**
 * Publishes the semantic state after route renders, query-cache writes, local
 * UI mutations, and visibility changes. The store drops semantic no-ops, so a
 * busy page can redraw without flooding the Realtime session.
 */
export function TalkContextBridge() {
  const location = useLocation()
  const todosTabFocused = useSyncExternalStore(subscribeTodosTabFocused, getTodosTabFocused, () => false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const publish = () => {
      timer = null
      if (stopped) return
      const root = document.getElementById("root")
      if (!root) return
      publishScreenContext(buildScreenContext({
        location: describeScreenLocation(location.pathname, location.search, todosTabFocused ? readTodosTabLocation() : null),
        browserInstanceId: browserInstanceId(),
        root,
      }))
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(publish, SETTLE_MS)
    }

    schedule()
    // The tab's own board and filters move without the address moving.
    const unsubscribeTab = todosTabFocused ? subscribeTodosTabLocation(schedule) : () => {}
    const unsubscribeQuery = queryClient.getQueryCache().subscribe(schedule)
    const observer = new MutationObserver(schedule)
    const root = document.getElementById("root")
    if (root) observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
    document.addEventListener("visibilitychange", schedule)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      unsubscribeQuery()
      unsubscribeTab()
      observer.disconnect()
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [location.pathname, location.search, todosTabFocused])

  return null
}
