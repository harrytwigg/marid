/**
 * How a link opens the Todos tab of the chat page. The tab lives in the chat route's layout, so a
 * link to it is a link to that route carrying a one-shot intent: the page opens (or focuses) the
 * tab, then drops the parameter, so a reload or a copied address never replays it.
 */

export const OPEN_PARAM = 'open'
const OPEN_TODOS = 'todos'

/** The chat route, asking for the Todos tab. */
export const TODOS_TAB_HREF = `/?${OPEN_PARAM}=${OPEN_TODOS}`

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
