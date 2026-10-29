import { isFileTabId, parseFileTabId, type FileTabRef } from './file-tab'
import { isSubagentTabId, parseSubagentTabId, type SubagentTabRef } from './subagent-tab'

/**
 * The kinds of tab the split layout holds. The layout keeps tabs as plain strings, so every kind but
 * a chat is an id in its own prefixed namespace, which a session id never carries:
 *
 * - a chat: a session id;
 * - a new chat (`new:`): a blank composer that becomes a chat on its first send. Like a chat it is
 *   its pane's identity when shown (its own composer pane, not drawn over a chat that stays mounted),
 *   but it is no session: the route and the working set never see it;
 * - a document (file-tab.ts `file:`, `todo:`, subagent-tab.ts `subagent:`): something read beside a chat. It is shown over its
 *   group's chat, which stays mounted under it, or, dragged out, in a pane of its own;
 * - the Todos board (`todos:`): one tab at most, the board the Todos screen shows. It is drawn as a
 *   document is, but belongs to no chat: it is opened on its own, not from a link in one.
 */
export type PaneTabKind = 'chat' | 'new-chat' | 'file' | 'todo' | 'subagent' | 'todos'

const TODO_TAB_PREFIX = 'todo:'
const NEW_CHAT_TAB_PREFIX = 'new:'

/** The Todos board's tab. There is only ever one, so its id is fixed: opening it again shows it. */
export const TODOS_TAB_ID = 'todos:'

/** What the Todos board's tab is called, in a strip and in a lone pane's title bar. */
export const TODOS_TAB_TITLE = 'Todos'

export function isTodoTabId(tabId: string): boolean {
  return tabId.startsWith(TODO_TAB_PREFIX)
}

export function isTodosTabId(tabId: string): boolean {
  return tabId === TODOS_TAB_ID
}

export function isNewChatTabId(tabId: string): boolean {
  return tabId.startsWith(NEW_CHAT_TAB_PREFIX)
}

/** A file, a Todo, a sub-agent or the Todos board: a tab shown over its group's chat rather than a pane of its own. */
export function isDocTabId(tabId: string): boolean {
  return isFileTabId(tabId) || isTodoTabId(tabId) || isSubagentTabId(tabId) || isTodosTabId(tabId)
}

/** A session: the only kind the route, the URL and the working set know. */
export function isChatTabId(tabId: string): boolean {
  return paneTabKind(tabId) === 'chat'
}

export function paneTabKind(tabId: string): PaneTabKind {
  if (isFileTabId(tabId)) return 'file'
  if (isTodoTabId(tabId)) return 'todo'
  if (isSubagentTabId(tabId)) return 'subagent'
  if (isTodosTabId(tabId)) return 'todos'
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
export type DocTabRef = { kind: 'file'; file: FileTabRef } | { kind: 'todo'; todoId: string } | { kind: 'subagent'; subagent: SubagentTabRef } | { kind: 'todos' }

export function parseDocTabId(tabId: string): DocTabRef | null {
  if (isTodosTabId(tabId)) return { kind: 'todos' }
  const file = parseFileTabId(tabId)
  if (file) return { kind: 'file', file }
  const todoId = parseTodoTabId(tabId)
  if (todoId) return { kind: 'todo', todoId }
  const subagent = parseSubagentTabId(tabId)
  return subagent ? { kind: 'subagent', subagent } : null
}
