import { useEffect, useMemo } from 'react'
import type { Message } from '@/lib/conversations'

export function useOnboardingSeed(sessionId: string | null, pendingUserMessage?: Message): Message | undefined {
  const seed = useMemo<Message | undefined>(() => {
    if (!sessionId || pendingUserMessage) return undefined
    try {
      const raw = sessionStorage.getItem('hundredfold-onboarding-seed')
      if (!raw) return undefined
      const data = JSON.parse(raw) as { sessionId: string; message: Message }
      if (data.sessionId === sessionId) return data.message
    } catch { /* ignore */ }
    return undefined
  }, [sessionId, pendingUserMessage])

  useEffect(() => {
    if (seed) sessionStorage.removeItem('hundredfold-onboarding-seed')
  }, [seed])

  return seed
}
