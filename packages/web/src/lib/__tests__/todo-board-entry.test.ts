import { describe, expect, it } from 'vitest'
import { hasTodosOpenIntent, todoBoardOpenIntent, todoBoardTabHref, withoutOpenIntent } from '../todos-tab-entry'

describe('the link that pins a Todo\'s sub-board as a tab', () => {
  it('is the chat route carrying a one-shot open intent', () => {
    expect(todoBoardTabHref('ACM-7')).toBe('/?open=todo-board:ACM-7')
  })

  it('reads the Todo back from the query string, and only for a valid Todo id', () => {
    expect(todoBoardOpenIntent('?open=todo-board:ACM-7')).toBe('ACM-7')
    expect(todoBoardOpenIntent('?open=todo-board%3AACM-7&session=x')).toBe('ACM-7')
    expect(todoBoardOpenIntent('?open=todo-board:')).toBeNull()
    expect(todoBoardOpenIntent('?open=todo-board:nope')).toBeNull()
    expect(todoBoardOpenIntent('?open=todos')).toBeNull()
    expect(todoBoardOpenIntent('')).toBeNull()
  })

  it('is not the Todos-tab intent, and drops from the address the same way', () => {
    expect(hasTodosOpenIntent('?open=todo-board:ACM-7')).toBe(false)
    expect(withoutOpenIntent('?open=todo-board:ACM-7&session=x')).toBe('?session=x')
    expect(withoutOpenIntent('?open=todo-board:ACM-7')).toBe('')
  })
})
