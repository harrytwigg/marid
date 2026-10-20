import { describe, expect, it } from 'vitest'
import { chatHeaderEmployee, chatHeaderTitle } from '../header-title'

const meta = (sessionId: string, title?: string, employee?: string) => ({ sessionId, title, employee })

describe('chatHeaderTitle', () => {
  it('names the composer rather than a session', () => {
    expect(chatHeaderTitle({ focusedSessionId: null, meta: null, sessions: [] })).toBe('New chat')
  })

  it('prefers live meta for the focused chat', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', 'Live title'),
      sessions: [{ id: 'a', title: 'List title' }],
    })).toBe('Live title')
  })

  it('falls back to the sessions list while that chat’s meta is still in flight', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: null,
      sessions: [{ id: 'b', title: 'Chat B' }, { id: 'a', title: 'List title' }],
    })).toBe('List title')
  })

  it('never renders another chat’s title when meta lags a switch', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'b',
      meta: meta('a', 'Chat A'),
      sessions: [{ id: 'a', title: 'Chat A' }, { id: 'b', title: 'Chat B' }],
    })).toBe('Chat B')
  })

  it('does not leak another chat’s title when the list has nothing either', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'b',
      meta: meta('a', 'Chat A'),
      sessions: [{ id: 'a', title: 'Chat A' }],
    })).toBe('')
  })

  it('names the employee when neither source has a title', () => {
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', undefined, 'a-lead'),
      sessions: [{ id: 'a', employee: 'a-lead' }],
    })).toBe('a-lead')
  })

  it('yields nothing when no source names the chat, leaving the word to the caller', () => {
    // Desktop shows nothing here and always has; the mobile nav bar, which
    // centres this string unconditionally, is the one that stands a word in.
    expect(chatHeaderTitle({
      focusedSessionId: 'a',
      meta: meta('a', '   '),
      sessions: [{ id: 'a', title: '' }],
    })).toBe('')
  })

  it('renders the arriving title once meta lands', () => {
    const sessions = [{ id: 'a', title: 'List title' }]
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: null, sessions })).toBe('List title')
    expect(chatHeaderTitle({ focusedSessionId: 'a', meta: meta('a', 'Fetched title'), sessions }))
      .toBe('Fetched title')
  })

  it('never names a chat other than the focused one', () => {
    const sessions = [{ id: 'a', title: 'Chat A' }, { id: 'b', title: 'Chat B' }]
    for (const meta of [null, { sessionId: 'a', title: 'Chat A' }]) {
      expect(chatHeaderTitle({ focusedSessionId: 'b', meta, sessions: [sessions[0]] })).toBe('')
      expect(chatHeaderTitle({ focusedSessionId: 'b', meta, sessions })).toBe('Chat B')
    }
  })
})

describe('chatHeaderEmployee', () => {
  const employees = [{ name: 'a-lead', displayName: 'A Lead' }]
  const base = { employees, portalName: 'Portal' }

  it('names the employee the composer will start the chat as', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: null, meta: meta('new', undefined, 'a-lead'), sessions: [] })).toBe('A Lead')
  })

  it('names the portal for a composer with nobody picked', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: null, meta: null, sessions: [] })).toBe('Portal')
    expect(chatHeaderEmployee({ ...base, focusedSessionId: null, meta: meta('new'), sessions: [] })).toBe('Portal')
  })

  it('names the employee of the focused chat, display name first', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: meta('a', 'T', 'a-lead'), sessions: [] })).toBe('A Lead')
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: null, sessions: [{ id: 'a', employee: 'a-lead' }] })).toBe('A Lead')
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: meta('a', 'T', 'gone'), sessions: [] })).toBe('gone')
  })

  it('names the portal for a chat with no employee', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: meta('a', 'T'), sessions: [] })).toBe('Portal')
  })

  it('says nothing while the focused chat is unknown, and never names the chat it replaced', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'b', meta: meta('a', 'T', 'a-lead'), sessions: [{ id: 'a', employee: 'a-lead' }] })).toBe('')
  })

  it('says nothing for a terminal, which is a shell and not an employee', () => {
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: { sessionId: 'a', engine: 'terminal' }, sessions: [] })).toBe('')
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: null, sessions: [{ id: 'a', source: 'terminal' }] })).toBe('')
    expect(chatHeaderEmployee({ ...base, focusedSessionId: 'a', meta: meta('a', 'T', '__terminal__'), sessions: [] })).toBe('')
  })
})
