import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { StaleChatNotice } from '@/components/chat/stale-chat-notice'
import { useFeatures } from '@/hooks/use-features'
import {
  dismissStaleChat,
  isStaleChatDismissed,
  shouldSuggestFreshChat,
  type StaleChatPolicy,
} from '@/lib/stale-chat'

/** What a continuation chat inherits from the session it replaces. */
export interface FreshChatSourceSession {
  id: string
  employee?: string
  engine?: string
  model?: string
  effortLevel?: string
  /** The declared Claude account the session runs on (`claudeProfile.name`); absent on its employee's own login. */
  profile?: string
}

const POLICY_OFF: StaleChatPolicy = { enabled: false, tokenThreshold: 300_000, staleAfterMinutes: 60 }

/** A send answers the notice for the activity the user saw when they sent. */
interface SendSuppression {
  sessionId: string
  lastActivity: string | null
}

interface SessionStaleness {
  contextTokens: number | null
  lastActivity: string | null
  status: string | undefined
}

function readStaleness(
  session: Record<string, unknown> | null,
  liveContextTokens: number | null,
  turnRunning: boolean,
): SessionStaleness {
  return {
    contextTokens: liveContextTokens ?? (session?.lastContextTokens as number | null | undefined) ?? null,
    lastActivity: (session?.lastActivity as string | null | undefined) ?? null,
    status: turnRunning ? 'running' : (session?.status as string | undefined),
  }
}

function toFreshChatSource(id: string, session: Record<string, unknown>): FreshChatSourceSession {
  const effortLevel = session.effortLevel ?? session.effort_level
  const profileName = (session.claudeProfile as { name?: unknown } | null | undefined)?.name
  const engine = typeof session.engine === 'string' ? session.engine : undefined
  return {
    id,
    employee: typeof session.employee === 'string' ? session.employee : undefined,
    engine,
    // The profile only means anything while the session is still on claude (a fallback leaves it).
    profile: engine === 'claude' && typeof profileName === 'string' ? profileName : undefined,
    model: typeof session.model === 'string' ? session.model : undefined,
    effortLevel: typeof effortLevel === 'string' ? effortLevel : undefined,
  }
}

function isDismissed(sessionId: string | null, dismissedSessionId: string | null): boolean {
  return Boolean(sessionId && (dismissedSessionId === sessionId || isStaleChatDismissed(sessionId)))
}

/**
 * True while the session has not moved past the send that answered the notice.
 * The suppression lifts on its own once activity advances, so a session that
 * goes stale again can suggest a fresh chat again.
 */
function isSuppressed(
  suppression: SendSuppression | null,
  sessionId: string | null,
  lastActivity: string | null,
): boolean {
  return suppression?.sessionId === sessionId && suppression?.lastActivity === lastActivity
}

function isNoticeVisible(input: {
  policy: StaleChatPolicy
  sessionId: string | null
  viewMode: 'chat' | 'cli'
  staleness: SessionStaleness
  now: number
  suggestedSessionId: string | null
  dismissed: boolean
  suppressed: boolean
}): boolean {
  if (!input.sessionId || input.viewMode !== 'chat') return false
  if (input.dismissed || input.suppressed) return false
  if (input.suggestedSessionId === input.sessionId) return input.policy.enabled
  return shouldSuggestFreshChat({
    policy: input.policy,
    status: input.staleness.status,
    contextTokens: input.staleness.contextTokens,
    lastActivity: input.staleness.lastActivity,
    now: input.now,
    dismissed: input.dismissed,
  })
}

function renderNotice(input: {
  staleness: SessionStaleness
  now: number
  onDismiss: () => void
  onStartFresh: () => Promise<void>
}): ReactNode | undefined {
  const { contextTokens, lastActivity } = input.staleness
  if (contextTokens == null || !lastActivity) return undefined
  return (
    <StaleChatNotice
      contextTokens={contextTokens}
      idleMinutes={(input.now - Date.parse(lastActivity)) / 60_000}
      onDismiss={input.onDismiss}
      onStartFresh={input.onStartFresh}
    />
  )
}

/** The session-scoped record of the suggestion: whether it has been raised,
 *  dismissed for good, or answered by sending a message. */
function useNoticeAnswers(sessionId: string | null, lastActivity: string | null) {
  const [suggestedSessionId, setSuggestedSessionId] = useState<string | null>(null)
  const [dismissedSessionId, setDismissedSessionId] = useState<string | null>(null)
  const [suppression, setSuppression] = useState<SendSuppression | null>(null)

  const dismiss = useCallback(() => {
    if (!sessionId) return
    dismissStaleChat(sessionId)
    setDismissedSessionId(sessionId)
    setSuggestedSessionId(null)
  }, [sessionId])

  // Unlike dismiss(), a send persists nothing: one message must not silence the
  // feature for good.
  const answerBySending = useCallback(() => {
    if (!sessionId) return
    setSuppression({ sessionId, lastActivity })
    setSuggestedSessionId(null)
  }, [sessionId, lastActivity])

  return {
    suggestedSessionId,
    suggest: setSuggestedSessionId,
    dismissed: isDismissed(sessionId, dismissedSessionId),
    suppressed: isSuppressed(suppression, sessionId, lastActivity),
    dismiss,
    answerBySending,
  }
}

interface StaleChatNoticeInput {
  sessionId: string | null
  session: Record<string, unknown> | null
  viewMode: 'chat' | 'cli'
  liveContextTokens: number | null
  turnRunning: boolean
  onStartFreshChat?: (session: FreshChatSourceSession) => Promise<void>
}

/**
 * Owns the "Start a fresh chat?" suggestion: when it shows, how it is answered,
 * and the element the transcript renders as its footer.
 */
export function useStaleChatNotice(
  { sessionId, session, viewMode, liveContextTokens, turnRunning, onStartFreshChat }: StaleChatNoticeInput,
) {
  const { data: features } = useFeatures()
  const policy = features?.staleChat ?? POLICY_OFF
  const [now, setNow] = useState(() => Date.now())
  const staleness = readStaleness(session, liveContextTokens, turnRunning)
  const { suggestedSessionId, suggest, dismissed, suppressed, dismiss, answerBySending }
    = useNoticeAnswers(sessionId, staleness.lastActivity)
  const visible = isNoticeVisible({
    policy, sessionId, viewMode, staleness, now, suggestedSessionId, dismissed, suppressed,
  })

  // Once suggested, the notice holds its place until it is answered — it must
  // not flicker away on the next clock tick.
  useEffect(() => {
    if (visible && sessionId) suggest(sessionId)
  }, [visible, sessionId, suggest])

  useEffect(() => {
    if (!sessionId || !policy.enabled || visible) return
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [sessionId, policy.enabled, visible])

  const startFresh = useCallback(async () => {
    if (!sessionId || !session || !onStartFreshChat) throw new Error('Fresh chat is unavailable')
    await onStartFreshChat(toFreshChatSource(sessionId, session))
  }, [session, onStartFreshChat, sessionId])

  const notice = visible
    ? renderNotice({ staleness, now, onDismiss: dismiss, onStartFresh: startFresh })
    : undefined

  return { notice, answerBySending }
}
