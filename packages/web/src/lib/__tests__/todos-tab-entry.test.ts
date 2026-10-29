import { describe, expect, it } from 'vitest'
import { hasTodosOpenIntent, TODOS_TAB_HREF, withoutOpenIntent } from '../todos-tab-entry'

describe('the Todos tab link', () => {
  it('is the chat route with the one-shot parameter', () => {
    expect(TODOS_TAB_HREF).toBe('/?open=todos')
    expect(hasTodosOpenIntent(new URL(TODOS_TAB_HREF, 'http://x').search)).toBe(true)
  })

  it('is an intent only for the Todos value', () => {
    expect(hasTodosOpenIntent('')).toBe(false)
    expect(hasTodosOpenIntent('?open=other')).toBe(false)
    expect(hasTodosOpenIntent('?session=a&open=todos')).toBe(true)
  })

  it('is dropped from the address and nothing else is', () => {
    expect(withoutOpenIntent('?open=todos')).toBe('')
    expect(withoutOpenIntent('?session=a&open=todos&x=1')).toBe('?session=a&x=1')
    expect(withoutOpenIntent('?session=a')).toBe('?session=a')
  })
})
