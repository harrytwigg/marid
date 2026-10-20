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
  employees,
}: {
  focusedSessionId: string | null
  meta: SessionMeta | null
  sessions: ReadonlyArray<ListedSession> | undefined
  /** Names an untitled chat by its employee's display name rather than the slug. */
  employees?: ReadonlyArray<{ name: string; displayName?: string }>
}): string {
  if (!focusedSessionId) return 'New chat'
  const live = meta?.sessionId === focusedSessionId ? meta : undefined
  const listed = sessions?.find((session) => String(session.id ?? '') === focusedSessionId)
  const employeeName = (slug: unknown) => displayable(employees?.find((employee) => employee.name === slug)?.displayName) ?? slug
  const candidates = [live?.title, listed?.title, employeeName(live?.employee), employeeName(listed?.employee)]
  return candidates.map(displayable).find(Boolean) ?? ''
}

type NamedEmployee = { name: string; displayName?: string }

/** The slug the focused chat runs as: null for the portal's own, undefined while nothing names it yet. */
function chatEmployeeSlug(input: {
  focusedSessionId: string | null
  live: SessionMeta | undefined
  listed: ListedSession | undefined
  picked: string | null | undefined
}): string | null | undefined {
  if (!input.focusedSessionId) return displayable(input.picked) ?? null
  if (input.live || input.listed) return displayable(input.live?.employee) ?? displayable(input.listed?.employee) ?? null
  // A first-sent chat the meta and the list do not carry yet: the composer's pick stands in.
  return displayable(input.picked)
}

/**
 * Who the focused chat runs as, for the mobile nav bar, or '' when that is not known yet or does not
 * apply (a terminal is a shell, not an employee). A chat with no employee is the portal's own, so it is
 * named by the portal. A composer has no session to ask: it reads the employee the operator picked in
 * it (`picked`, null for the portal). Every other source is keyed to the id now in front of the reader,
 * as the title's are.
 */
export function chatHeaderEmployee({
  focusedSessionId,
  meta,
  sessions,
  employees,
  portalName,
  picked,
}: {
  focusedSessionId: string | null
  meta: SessionMeta | null
  sessions: ReadonlyArray<ListedSession> | undefined
  employees: ReadonlyArray<NamedEmployee> | undefined
  portalName: string
  picked?: string | null
}): string {
  const { live, listed } = focusedChat(focusedSessionId, meta, sessions)
  if (isTerminalSession({ engine: live?.engine ?? listed?.engine, source: listed?.source })) return ''
  const slug = chatEmployeeSlug({ focusedSessionId, live, listed, picked })
  if (slug === undefined || slug === TERMINAL_AVATAR) return ''
  return slug === null ? portalName : employeeDisplayName(slug, employees)
}

function focusedChat(focusedSessionId: string | null, meta: SessionMeta | null, sessions: ReadonlyArray<ListedSession> | undefined) {
  if (!focusedSessionId) return { live: undefined, listed: undefined }
  return {
    live: meta?.sessionId === focusedSessionId ? meta : undefined,
    listed: sessions?.find((session) => String(session.id ?? '') === focusedSessionId),
  }
}

function employeeDisplayName(slug: string, employees: ReadonlyArray<NamedEmployee> | undefined): string {
  return displayable(employees?.find((employee) => employee.name === slug)?.displayName) ?? slug
}

/** The employee line under the title, or undefined when the title already says it (an untitled chat is
 *  titled by its employee). */
export function chatHeaderEmployeeLine(title: string, employee: string): string | undefined {
  return employee && employee !== title ? employee : undefined
}
