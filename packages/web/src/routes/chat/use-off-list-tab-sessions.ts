import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'

export interface TabSession {
  id?: unknown
  title?: unknown
  employee?: unknown
}

/**
 * Titles for tabs whose chat the session list does not carry. The list is only
 * the newest chats per group plus whatever was paged in, so absence from it says
 * nothing about whether a chat exists. Each such tab is looked up once: a
 * definite "not found" or an archived chat reports it gone, and any other
 * failure leaves the tab alone and lets the next pass retry.
 */
export function useOffListTabSessions(
  tabIds: readonly string[],
  listedIds: ReadonlySet<string> | null,
  onGone: (sessionId: string) => void,
): Record<string, TabSession> {
  const [found, setFound] = useState<Record<string, TabSession>>({})
  const asked = useRef(new Set<string>())

  useEffect(() => {
    if (!listedIds) return
    for (const id of tabIds) {
      if (listedIds.has(id) || asked.current.has(id)) continue
      asked.current.add(id)
      api.getSession(id, { messages: false }).then((session) => {
        if (session.archivedAt) onGone(id)
        else setFound((current) => ({ ...current, [id]: session }))
      }).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) onGone(id)
        else asked.current.delete(id)
      })
    }
  }, [tabIds, listedIds, onGone])

  return found
}
