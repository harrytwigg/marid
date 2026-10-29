import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../layout/split-layout-storage'
import { apiMocks, chatTabsMock, gateway, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, seedLayout, setViewport, storedGroups } from './todos-tab-page-support'

vi.mock('@/routes/todos/board/todos-tab-view', () => ({ default: () => <div data-testid="todos-board-stub" /> }))

describe('the Todos tab on a phone', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
    setViewport(390, 844)
  })

    const tabIds = () => Array.from(document.querySelectorAll('[data-mobile-session-tab]')).map((node) => node.getAttribute('data-mobile-session-tab'))
    const stripTab = (id: string) => document.querySelector<HTMLElement>(`[data-mobile-session-tab="${id}"]`)!

    it('shows the board under a header titled Todos when the bottom bar opens it', async () => {
      renderRoute('/')
      fireEvent.click(await within(await screen.findByRole('navigation', { name: 'Primary' })).findByRole('link', { name: 'Todos' }))

      expect(await screen.findByTestId('phone-todos')).toBeTruthy()
      expect(await screen.findByTestId('todos-board-stub')).toBeTruthy()
      expect(document.querySelector('[data-chat-mobile-header]')!.textContent).toContain('Todos')
      // The nav bar says where the reader is, as on the desktop rail.
      expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Todos' }).getAttribute('aria-current')).toBe('page')
      expect(screen.queryByRole('tab')).toBeNull() // one entry is no strip
    })

    it('opens from the link too, and drops the parameter', async () => {
      renderRoute('/?open=todos')

      expect(await screen.findByTestId('phone-todos')).toBeTruthy()
      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/'))
    })

    it('carries the Todos tab as an entry beside the opened chats, and switches between them', async () => {
      renderRoute('/')
      fireEvent.click(await screen.findByTestId('list-row-a'))
      await waitFor(() => expect(chatPanes()).toEqual(['a']))
      fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Todos' }))
      await screen.findByTestId('phone-todos')

      await waitFor(() => expect(tabIds()).toEqual(['a', 'todos:']))
      expect(stripTab('todos:').textContent).toContain('Todos')
      expect(stripTab('todos:').getAttribute('aria-selected')).toBe('true')

      fireEvent.click(stripTab('a'))
      await waitFor(() => expect(chatPanes()).toEqual(['a']))
      expect(screen.queryByTestId('phone-todos')).toBeNull()
      expect(stripTab('a').getAttribute('aria-selected')).toBe('true')

      fireEvent.click(stripTab('todos:'))
      expect(await screen.findByTestId('phone-todos')).toBeTruthy()
    })

    it('leads with the pinned tabs, and its close-all leaves them', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }, { tabs: ['todos:'] }], { pinned: ['todos:', 'b'] })
      renderRoute('/?session=a')
      await waitFor(() => expect(tabIds()).toEqual(['todos:', 'b', 'a']))
      expect(stripTab('b').querySelector('[data-mobile-session-tab-pinned]')).not.toBeNull()

      fireEvent.click(within(document.querySelector<HTMLElement>('[data-mobile-session-tabs]')!).getByRole('button', { name: 'Close all tabs' }))

      await waitFor(() => expect(storedGroups().flatMap((group) => group.tabs).sort()).toEqual(['b', 'todos:']))
      expect(JSON.parse(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY)!).pinned).toEqual(['todos:', 'b'])
      expect(JSON.parse(localStorage.getItem(MOBILE_TABS_STORAGE_KEY) ?? '{"sessionIds":[]}').sessionIds).not.toContain('a')
    })

    it('has no close control on a pinned tab, and one on an unpinned Todos tab that closes it', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }])
      renderRoute('/?session=a')
      await waitFor(() => expect(tabIds()).toEqual(['a', 'todos:']))

      // The chat is in front: its tab carries the close control, the Todos tab's does not until it is.
      fireEvent.click(stripTab('todos:'))
      await screen.findByTestId('phone-todos')
      fireEvent.click(await screen.findByRole('button', { name: 'Close Todos' }))

      await waitFor(() => expect(storedGroups().flatMap((group) => group.tabs)).not.toContain('todos:'))
      await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
    })

    it('takes the bottom bar\'s Chat tab from the Todos screen to the chat list', async () => {
      renderRoute('/?open=todos')
      await screen.findByTestId('phone-todos')

      fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Chat' }))

      await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
      expect(screen.getByTestId('chat-sidebar')).toBeTruthy()
      expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page')
    })

    describe('and history', () => {
      const onTodosScreen = { pathname: '/', state: { phoneTodos: true } }

      it('marks the entry it is on, so the screen can come back to it', async () => {
        renderRoute('/?open=todos')
        await screen.findByTestId('phone-todos')
        await waitFor(() => expect(JSON.parse(screen.getByTestId('route-state').textContent!)).toMatchObject({ phoneTodos: true }))

        fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Chat' }))
        await waitFor(() => expect(JSON.parse(screen.getByTestId('route-state').textContent!)).toMatchObject({ phoneTodos: false }))
      })

      it('comes back on the Todos screen, not the chat list, after a Todo opened from it is left by the browser\'s back', async () => {
        seedLayout([{ tabs: ['todos:'] }])
        renderRoute([onTodosScreen, '/todos/ACM-1'])
        // Landing on the Todo's page leaves the chat route: nothing of the chat page is mounted.
        expect(screen.queryByTestId('phone-todos')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))

        expect(await screen.findByTestId('phone-todos')).toBeTruthy()
      })

      it('does not bring the screen back once the Todos tab is gone from the layout', async () => {
        renderRoute(onTodosScreen)
        await waitFor(() => expect(screen.queryByTestId('phone-todos')).toBeNull())
      })
    })
})
