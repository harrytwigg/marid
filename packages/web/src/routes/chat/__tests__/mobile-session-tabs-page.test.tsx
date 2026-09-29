import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { ApiError } from '@/lib/api'
import { apiMocks, emit, gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

/**
 * The phone's tabs are the chats the operator opened, in the order they opened
 * them. The route primes the newest chat and the gateway lists every chat, and
 * neither earns a tab.
 */
describe('mobile session tabs on the routed page', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
  })

  const tabIds = () => Array.from(document.querySelectorAll('[data-mobile-session-tab]')).map((node) => node.getAttribute('data-mobile-session-tab'))
  const stored = (): string[] => {
    const raw = localStorage.getItem(MOBILE_TABS_STORAGE_KEY)
    return raw ? (JSON.parse(raw).sessionIds ?? []) : []
  }
  const openFromList = async (id: string) => {
    fireEvent.click(await screen.findByTestId(`list-row-${id}`))
    await waitFor(() => expect(pane(id)).toBeDefined())
  }
  const backToList = () => fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])

  it('shows no strip for one open chat and no tab for chats nobody opened', async () => {
    renderRoute('/')
    await openFromList('a')

    expect(document.querySelector('[data-mobile-session-tabs]')).toBeNull()
    expect(tabIds()).toEqual([])
    await waitFor(() => expect(stored()).toEqual(['a']))
  })

  it('adds a tab per opened chat, in opening order, and no back-filled ones', async () => {
    renderRoute('/')
    await openFromList('a')
    backToList()
    await openFromList('c')

    await waitFor(() => expect(tabIds()).toEqual(['a', 'c']))
    expect(screen.getByRole('tab', { name: 'Title c' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('tab', { name: 'Title b' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Title d' })).toBeNull()

    // Returning to an earlier chat keeps its place instead of re-ranking.
    fireEvent.click(screen.getByRole('tab', { name: 'Title a' }))
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    expect(tabIds()).toEqual(['a', 'c'])
    expect(stored()).toEqual(['a', 'c'])
  })

  it('closes the focused tab, moves to its neighbour, and drops the strip at one chat', async () => {
    renderRoute('/')
    await openFromList('a')
    backToList()
    await openFromList('b')
    await waitFor(() => expect(tabIds()).toEqual(['a', 'b']))

    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))

    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    expect(document.querySelector('[data-mobile-session-tabs]')).toBeNull()
    await waitFor(() => expect(stored()).toEqual(['a']))
  })

  it('gives a closed chat a fresh tab when it is opened again', async () => {
    renderRoute('/')
    await openFromList('a')
    backToList()
    await openFromList('b')
    fireEvent.click(await screen.findByRole('button', { name: 'Close Title b' }))
    await waitFor(() => expect(stored()).toEqual(['a']))

    backToList()
    await openFromList('b')
    await waitFor(() => expect(tabIds()).toEqual(['a', 'b']))
  })

  it('restores tabs across a reload', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a'], focusedId: 'a', focusHistory: ['a'] }))
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'c'] }))
    renderRoute('/?session=a')

    await waitFor(() => expect(tabIds()).toEqual(['a', 'c']))
    expect(stored()).toEqual(['a', 'c'])
  })

  // The list is only the newest chats per group, so a chat missing from it may
  // still exist. Its tab must survive, keep its name, and stay in storage.
  it('keeps the tab of a chat the session list does not carry, named from a direct lookup', async () => {
    const listSessions = apiMocks.getSessions.getMockImplementation()!
    apiMocks.getSessions.mockImplementation(async () => ({
      sessions: sessionIds.filter((id) => id !== 'c').map((id) => ({ id, title: `Title ${id}`, status: 'idle' })), counts: {}, perGroup: {},
    }))
    try {
      localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b', 'c'] }))
      renderRoute('/?session=b')

      await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Title a', 'Title b', 'Title c']))
      expect(stored()).toEqual(['a', 'b', 'c'])
    } finally {
      apiMocks.getSessions.mockImplementation(listSessions)
    }
  })

  it('keeps an off-list tab, and its place in storage, after the reader switches to another tab', async () => {
    const listSessions = apiMocks.getSessions.getMockImplementation()!
    apiMocks.getSessions.mockImplementation(async () => ({
      sessions: sessionIds.filter((id) => id !== 'c').map((id) => ({ id, title: `Title ${id}`, status: 'idle' })), counts: {}, perGroup: {},
    }))
    try {
      localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b', 'c'] }))
      renderRoute('/?session=a')
      await waitFor(() => expect(tabIds()).toEqual(['a', 'b', 'c']))

      fireEvent.click(screen.getByRole('tab', { name: 'Title b' }))
      await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))

      expect(tabIds()).toEqual(['a', 'b', 'c'])
      expect(stored()).toEqual(['a', 'b', 'c'])
    } finally {
      apiMocks.getSessions.mockImplementation(listSessions)
    }
  })

  it('drops the tab of a chat that a direct lookup reports as not found, and only that one', async () => {
    const getSession = apiMocks.getSession.getMockImplementation()!
    apiMocks.getSession.mockImplementation(async (id: string, ...rest: unknown[]) => {
      if (id === 'gone') throw new ApiError(404, 'not found')
      return (getSession as (id: string, ...rest: unknown[]) => Promise<unknown>)(id, ...rest) as never
    })
    const listSessions = apiMocks.getSessions.getMockImplementation()!
    apiMocks.getSessions.mockImplementation(async () => ({
      sessions: sessionIds.map((id) => ({ id, title: `Title ${id}`, status: 'idle' })), counts: {}, perGroup: {},
    }))
    try {
      sessionIds.splice(0, sessionIds.length, 'a', 'b')
      localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'gone', 'b'] }))
      renderRoute('/?session=a')

      await waitFor(() => expect(stored()).toEqual(['a', 'b']))
      expect(tabIds()).toEqual(['a', 'b'])
    } finally {
      apiMocks.getSession.mockImplementation(getSession)
      apiMocks.getSessions.mockImplementation(listSessions)
    }
  })

  it('drops a tab when the gateway reports its chat deleted', async () => {
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b', 'c'] }))
    renderRoute('/?session=a')
    await waitFor(() => expect(tabIds()).toEqual(['a', 'b', 'c']))

    emit('session:deleted', { sessionId: 'b' })

    await waitFor(() => expect(tabIds()).toEqual(['a', 'c']))
    expect(stored()).toEqual(['a', 'c'])
  })

  it('mounts only the active pane while open tabs switch the route-backed transcript', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b'], focusedId: 'a', focusHistory: ['a', 'b'] }))
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds }))
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1))
    expect(pane('a').textContent).toContain('transcript-a')
    await waitFor(() => expect(tabIds()).toEqual(sessionIds))

    fireEvent.click(await screen.findByRole('tab', { name: 'Title d' }))
    await waitFor(() => expect(pane('d').textContent).toContain('transcript-d'))
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1)
    expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull()
    expect(tabIds()).toEqual(sessionIds)
  })

  it('marks a background tab updated in place without touching the active transcript', async () => {
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds }))
    renderRoute()
    await waitFor(() => expect(tabIds()).toEqual(sessionIds))
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const activeBefore = pane('a').textContent
    const tabsBefore = sessionIds.map((id) => document.querySelector(`[data-mobile-session-tab="${id}"]`))

    emit('session:delta', { sessionId: 'c', type: 'text', content: 'background-mobile' })

    await waitFor(() => expect(document.querySelector('[data-mobile-session-tab-cell="c"] [data-mobile-session-tab-moved]')).not.toBeNull())
    expect(sessionIds.map((id) => document.querySelector(`[data-mobile-session-tab="${id}"]`))).toEqual(tabsBefore)
    expect(pane('a').textContent).toBe(activeBefore)
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1)
  })

  it('labels a tab with the chat name, without its "#12 - " id prefix', async () => {
    const listSessions = apiMocks.getSessions.getMockImplementation()!
    apiMocks.getSessions.mockImplementation(async () => ({
      sessions: sessionIds.map((id) => ({ id, title: `#${id.charCodeAt(0) - 96} - Name ${id}`, status: 'idle' })), counts: {}, perGroup: {},
    }))
    try {
      localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds }))
      renderRoute()
      await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(sessionIds.map((id) => `Name ${id}`)))
    } finally {
      apiMocks.getSessions.mockImplementation(listSessions)
    }
  })
})
