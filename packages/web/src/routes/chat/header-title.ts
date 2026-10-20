import { TERMINAL_AVATAR } from '@/components/ui/employee-avatar'
import { isTerminalSession } from '@/lib/terminal-session'
import type { SessionMeta } from './use-chat-pane-state'

/** A session as the list knows it — the authority the header can consult before
 *  that chat's own meta has been fetched. */
interface ListedSession {
  id?: unknown
  title?: unknown
  employee?: unknown
  engine?: unknown
  source?: unknown
}

function displayable(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

/**
 * The conversation title for the chat header, or '' when no source names the
 * focused chat yet.
 *
 * Live meta arrives per pane and lands a fetch after a switch, so every source
 * here is keyed to the id now in front of the reader: a fallback can name the
 * focused chat or nothing, never the chat it replaced. Standing in for a name
 * nobody knows is the caller's business — desktop shows nothing, and only the
 * mobile nav bar, which centres this string unconditionally, needs a word.
 */
export function chatHeaderTitle({
  focusedSessionId,
  meta,
  sessions,
}: {
  focusedSessionId: string | null
  meta: SessionMeta | null
  sessions: ReadonlyArray<ListedSession> | undefined
}): string {
  if (!focusedSessionId) return 'New chat'
  const live = meta?.sessionId === focusedSessionId ? meta : undefined
  const listed = sessions?.find((session) => String(session.id ?? '') === focusedSessionId)
  const candidates = [live?.title, listed?.title, live?.employee, listed?.employee]
  return candidates.map(displayable).find(Boolean) ?? ''
}

/**
 * Who the focused chat runs as, for the mobile nav bar, or '' when that is not known yet or does not
 * apply (a terminal is a shell, not an employee). A chat with no employee is the portal's own, so it is
 * named by the portal. The composer reads the employee the picker has chosen, which the pane reports
 * under the id 'new'. Every source is keyed to the id now in front of the reader, as the title's are.
 */
export function chatHeaderEmployee({
  focusedSessionId,
  meta,
  sessions,
  employees,
  portalName,
}: {
  focusedSessionId: string | null
  meta: SessionMeta | null
  sessions: ReadonlyArray<ListedSession> | undefined
  employees: ReadonlyArray<{ name: string; displayName?: string }> | undefined
  portalName: string
}): string {
  const live = focusedSessionId ? (meta?.sessionId === focusedSessionId ? meta : undefined) : meta ?? undefined
  const listed = focusedSessionId ? sessions?.find((session) => String(session.id ?? '') === focusedSessionId) : undefined
  if (focusedSessionId && !live && !listed) return ''
  if (isTerminalSession({ engine: live?.engine ?? listed?.engine, source: listed?.source })) return ''
  const slug = displayable(live?.employee) ?? displayable(listed?.employee)
  if (slug === TERMINAL_AVATAR) return ''
  if (!slug) return portalName
  return displayable(employees?.find((employee) => employee.name === slug)?.displayName) ?? slug
}
