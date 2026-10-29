import "@/test/preload-menus"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { apiMocks, chatTabsMock, gateway, renderDataRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, railLink, seedLayout, settled, setViewport, storedGroups, todosPanes } from './todos-tab-page-support'

vi.mock('@/routes/todos/board/todos-tab-view', () => ({ default: () => <div data-testid="todos-board-stub" /> }))

// The app's router is a data router, where a navigation is asynchronous and a later one replaces the one
// still pending: the page's history writes are only honest when they hold up here.
const routeLocation = () => screen.getByTestId('route-location').textContent
const routeState = () => JSON.parse(screen.getByTestId('route-state').textContent || 'null')
const stripTab = (id: string) => document.querySelector<HTMLElement>(`[data-mobile-session-tab="${id}"]`)!
const bottomBar = (name: string) => within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name })

describe('the Todos tab on a data router', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
  })

  describe('on a phone', () => {
    beforeEach(() => setViewport(390, 844))

    async function openChat(id: string) {
      fireEvent.click(await screen.findByTestId(`list-row-${id}`))
      await waitFor(() => expect(routeLocation()).toBe(`/?session=${id}`))
      await waitFor(() => expect(chatPanes()).toContain(id))
      fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
    }

    async function openTodosScreen() {
      fireEvent.click(bottomBar('Todos'))
      await screen.findByTestId('phone-todos')
      await waitFor(() => expect(routeState()).toMatchObject({ phoneTodos: true }))
    }

    it('lands on the chat chosen from the switcher, not on the one the route was on', async () => {
      renderDataRoute('/')
      await openChat('a')
      await openChat('b')
      await openTodosScreen()
      expect(routeLocation()).toBe('/?session=b')

      fireEvent.click(stripTab('a'))

      await waitFor(() => expect(routeLocation()).toBe('/?session=a'))
      await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
      // The route stays there once everything has settled, and its entry is not marked as the Todos screen.
      await settled()
      expect(routeLocation()).toBe('/?session=a')
      expect(stripTab('a').getAttribute('aria-selected')).toBe('true')
      expect(routeState()?.phoneTodos).not.toBe(true)
    })

    it('keeps the route on the chat the layout keeps when the Todos screen closes all', async () => {
      // The open-chats list's own active chat is b, the one the route is on; a is pinned in the layout.
      chatTabsMock.tabs = seededChatTabs().filter((tab) => tab.sessionId === 'b')
      seedLayout([{ tabs: ['a', 'b', 'todos:'], activeTab: 'b' }], { pinned: ['a', 'todos:'] })
      renderDataRoute('/?session=b')
      await waitFor(() => expect(stripTab('todos:')).toBeTruthy())
      fireEvent.click(stripTab('todos:'))
      await screen.findByTestId('phone-todos')
      expect(routeLocation()).toBe('/?session=b')

      fireEvent.click(within(document.querySelector<HTMLElement>('[data-mobile-session-tabs]')!).getByRole('button', { name: 'Close all tabs' }))

      await waitFor(() => expect(storedGroups().flatMap((group) => group.tabs).sort()).toEqual(['a', 'todos:']))
      await waitFor(() => expect(routeLocation()).toBe('/?session=a'))
      await settled()
      expect(routeLocation()).toBe('/?session=a')
    })

    it('leaves the Todos screen by the browser\'s back, for the chat the screen was reached from', async () => {
      renderDataRoute('/')
      await openChat('a')
      await openChat('b')
      await openTodosScreen()

      fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))

      await waitFor(() => expect(routeLocation()).toBe('/?session=a'))
      await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
      await settled()
      expect(routeLocation()).toBe('/?session=a')
      expect(screen.queryByTestId('phone-todos')).toBeNull()
      expect(routeState()?.phoneTodos).not.toBe(true)
    })

    it('brings the Todos screen back on forward to a bare entry marked with it', async () => {
      renderDataRoute('/')
      await openChat('a')
      fireEvent.click(await screen.findByTestId('list-row-b'))
      await waitFor(() => expect(routeLocation()).toBe('/?session=b'))
      fireEvent.click((await screen.findAllByRole('button', { name: 'Close all tabs' }))[0])
      await waitFor(() => expect(routeLocation()).toBe('/'))
      await openTodosScreen()
      expect(routeLocation()).toBe('/')

      fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
      await waitFor(() => expect(routeLocation()).toBe('/?session=b'))
      await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
      fireEvent.click(screen.getByRole('button', { name: 'Test browser forward' }))

      expect(await screen.findByTestId('phone-todos')).toBeTruthy()
      await settled()
      expect(screen.getByTestId('phone-todos')).toBeTruthy()
      expect(routeLocation()).toBe('/')
      expect(routeState()).toMatchObject({ phoneTodos: true })
    })
  })

  describe('on the desktop', () => {
    beforeEach(() => setViewport(1440, 900))

    it('opens the list\'s newest chat from the nav\'s Chat link when the layout holds no chat', async () => {
      seedLayout([{ tabs: ['todos:'] }])
      renderDataRoute('/')
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      expect(chatPanes()).toEqual([])

      fireEvent.click(railLink('Chat'))

      await waitFor(() => expect(chatPanes()).toEqual(['a']))
      expect(routeLocation()).toBe('/?session=a')
      expect(railLink('Chat').getAttribute('aria-current')).toBe('page')
    })

    describe('with sessions of every source', () => {
      const listed = apiMocks.getSessions.getMockImplementation()!
      afterEach(() => { apiMocks.getSessions.mockImplementation(listed) })

      it('opens the newest chat the list shows, not a connector\'s session or the first row the API returned', async () => {
        apiMocks.getSessions.mockImplementation(async () => ({
          sessions: [
            { id: 'c', title: 'Title c', status: 'idle', source: 'telegram', lastActivity: '2026-01-04T00:00:00Z' },
            { id: 'a', title: 'Title a', status: 'idle', lastActivity: '2026-01-01T00:00:00Z' },
            { id: 'b', title: 'Title b', status: 'idle', lastActivity: '2026-01-03T00:00:00Z' },
          ],
          counts: {},
          perGroup: {},
        }))
        seedLayout([{ tabs: ['todos:'] }])
        renderDataRoute('/')
        await waitFor(() => expect(todosPanes()).toHaveLength(1))

        fireEvent.click(railLink('Chat'))

        await waitFor(() => expect(chatPanes()).toEqual(['b']))
        expect(routeLocation()).toBe('/?session=b')
      })
    })
  })
})
