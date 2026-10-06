import { isFileTabId, parseFileTabId, type FileTabRef } from './file-tab'

/**
 * The kinds of tab the split layout holds. The layout keeps tabs as plain strings, so every kind but
 * a chat is an id in its own prefixed namespace, which a session id never carries:
 *
 * - a chat: a session id;
 * - a new chat (`new:`): a blank composer that becomes a chat on its first send. Like a chat it is
 *   its pane's identity when shown (its own composer pane, not drawn over a chat that stays mounted),
 *   but it is no session: the route and the working set never see it;
 * - a document (file-tab.ts `file:`, `todo:`): something read beside a chat. It is shown over its
 *   group's chat, which stays mounted under it, or, dragged out, in a pane of its own.
 */
export type PaneTabKind = 'chat' | 'new-chat' | 'file' | 'todo'

const TODO_TAB_PREFIX = 'todo:'
const NEW_CHAT_TAB_PREFIX = 'new:'

export function isTodoTabId(tabId: string): boolean {
  return tabId.startsWith(TODO_TAB_PREFIX)
}

export function isNewChatTabId(tabId: string): boolean {
  return tabId.startsWith(NEW_CHAT_TAB_PREFIX)
}

/** A file or a Todo: a tab shown over its group's chat rather than a pane of its own. */
export function isDocTabId(tabId: string): boolean {
  return isFileTabId(tabId) || isTodoTabId(tabId)
}

/** A session: the only kind the route, the URL and the working set know. */
export function isChatTabId(tabId: string): boolean {
  return paneTabKind(tabId) === 'chat'
}

export function paneTabKind(tabId: string): PaneTabKind {
  if (isFileTabId(tabId)) return 'file'
  if (isTodoTabId(tabId)) return 'todo'
  return isNewChatTabId(tabId) ? 'new-chat' : 'chat'
}

export function todoTabId(todoId: string): string {
  return `${TODO_TAB_PREFIX}${todoId}`
}

export function parseTodoTabId(tabId: string): string | null {
  return isTodoTabId(tabId) ? tabId.slice(TODO_TAB_PREFIX.length) || null : null
}

/** A new chat's tab: `serial` keeps two blank composers apart; `employee` is who it is addressed to. */
export interface NewChatTabRef {
  serial: number
  employee: string | null
}

export function newChatTabId({ serial, employee }: NewChatTabRef): string {
  const params = new URLSearchParams({ n: String(serial) })
  if (employee) params.set('employee', employee)
  return `${NEW_CHAT_TAB_PREFIX}${params.toString()}`
}

export function parseNewChatTabId(tabId: string): NewChatTabRef | null {
  if (!isNewChatTabId(tabId)) return null
  const params = new URLSearchParams(tabId.slice(NEW_CHAT_TAB_PREFIX.length))
  const serial = Number(params.get('n'))
  return Number.isInteger(serial) ? { serial, employee: params.get('employee') || null } : null
}

/** What a document tab shows. */
export type DocTabRef = { kind: 'file'; file: FileTabRef } | { kind: 'todo'; todoId: string }

export function parseDocTabId(tabId: string): DocTabRef | null {
  const file = parseFileTabId(tabId)
  if (file) return { kind: 'file', file }
  const todoId = parseTodoTabId(tabId)
  return todoId ? { kind: 'todo', todoId } : null
}
