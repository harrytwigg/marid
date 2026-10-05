import { useMemo } from "react"
import { narrowToProject, useProjectScope } from "@/components/projects/use-project-scope"
import type { Session } from "@/components/chat/session-signals"

// Sources the sidebar renders (others, e.g. slack/telegram, are shown elsewhere).
export function isVisibleSource(s: Pick<Session, "source">): boolean {
  return s.source === "web" || s.source === "terminal" || s.source === "talk" || s.source === "cron" || s.source === "workflow" || s.source === "plugin" || s.source === "whatsapp" || s.source === "discord" || !s.source
}

/** The sessions the sidebar lists: the loaded page plus pinned rows the page missed,
 *  newest activity first, narrowed to the active project's Todos when one is chosen. */
export function useSidebarSessions(rawSessions: unknown, pinnedRows: unknown): Session[] {
  const scope = useProjectScope()
  return useMemo(() => {
    if (!rawSessions) return []
    const filtered = (rawSessions as Session[]).filter(isVisibleSource)
    const loadedIds = new Set(filtered.map((session) => session.id))
    for (const session of pinnedRows as Session[]) {
      if (isVisibleSource(session) && !loadedIds.has(session.id)) {
        filtered.push(session)
        loadedIds.add(session.id)
      }
    }
    filtered.sort((a, b) => {
      const ta = a.lastActivity || a.createdAt || ""
      const tb = b.lastActivity || b.createdAt || ""
      return tb.localeCompare(ta)
    })
    return narrowToProject(filtered, scope)
  }, [rawSessions, pinnedRows, scope])
}
