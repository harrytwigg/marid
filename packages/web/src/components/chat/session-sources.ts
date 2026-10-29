import type { Session } from '@/components/chat/session-signals'

/** Sources the sidebar renders (others, e.g. slack/telegram, are shown elsewhere). */
export function isVisibleSource(s: Pick<Session, 'source'>): boolean {
  return s.source === 'web' || s.source === 'terminal' || s.source === 'talk' || s.source === 'cron' || s.source === 'workflow' || s.source === 'plugin' || s.source === 'whatsapp' || s.source === 'discord' || !s.source
}

/** The order the sidebar lists chats in, newest first. */
export function compareByRecency(a: Pick<Session, 'lastActivity' | 'createdAt'>, b: Pick<Session, 'lastActivity' | 'createdAt'>): number {
  return (b.lastActivity || b.createdAt || '').localeCompare(a.lastActivity || a.createdAt || '')
}

/** The newest chat the sidebar would list, which is the one a fresh load of the bare route opens. */
export function newestVisibleSessionId(rows: readonly Record<string, unknown>[] | undefined): string | null {
  const visible = ((rows ?? []) as unknown as Session[]).filter(isVisibleSource)
  return [...visible].sort(compareByRecency)[0]?.id ?? null
}
