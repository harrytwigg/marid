/**
 * How a link opens the Todos tab of the chat page. The tab lives in the chat route's layout, so a
 * link to it is a link to that route carrying a one-shot intent: the page opens (or focuses) the
 * tab, then drops the parameter, so a reload or a copied address never replays it.
 *
 * A Todo's sub-board as a pinned tab is asked for the same way: `/?open=todo-board:<id>`.
 */

import { isTodoId } from './todo-id'

export const OPEN_PARAM = 'open'
const OPEN_TODOS = 'todos'

/** The chat route, asking for the Todos tab. */
export const TODOS_TAB_HREF = `/?${OPEN_PARAM}=${OPEN_TODOS}`

const OPEN_TODO_BOARD_PREFIX = 'todo-board:'

/** The chat route, asking for a Todo's sub-board as a pinned tab. */
export function todoBoardTabHref(todoId: string): string {
  return `/?${OPEN_PARAM}=${OPEN_TODO_BOARD_PREFIX}${todoId}`
}

/** The Todo whose sub-board the query string asks to pin as a tab, if it asks for one and names a valid Todo id. */
export function todoBoardOpenIntent(search: string): string | null {
  const value = new URLSearchParams(search).get(OPEN_PARAM)
  if (!value?.startsWith(OPEN_TODO_BOARD_PREFIX)) return null
  const todoId = value.slice(OPEN_TODO_BOARD_PREFIX.length)
  return isTodoId(todoId) ? todoId : null
}

/** Whether the query string carries a sub-board open link at all, valid or not: a link naming no valid Todo is still
 * an intent the page consumes (drops from the address), though it opens nothing. */
export function hasTodoBoardOpenParam(search: string): boolean {
  return new URLSearchParams(search).get(OPEN_PARAM)?.startsWith(OPEN_TODO_BOARD_PREFIX) ?? false
}

/** Whether the query string asks for the Todos tab. */
export function hasTodosOpenIntent(search: string): boolean {
  return new URLSearchParams(search).get(OPEN_PARAM) === OPEN_TODOS
}

/** The query string once the intent is consumed; everything else in it stays. */
export function withoutOpenIntent(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(OPEN_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ''
}
