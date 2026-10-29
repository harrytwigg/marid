import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { apiMocks, chatTabsMock, gateway, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, composerPanes, railLink, seedLayout, settled, setViewport, storedGroups, todosPanes } from './todos-tab-page-support'

// The board has its own suites; here it is a stand-in that says it is on screen.
vi.mock('@/routes/todos/board/todos-tab-view', () => ({ default: () => <div data-testid="todos-board-stub" /> }))

describe('the Todos tab on the chat page', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
    setViewport(1440, 900)
  })

  describe('opened by a link', () => {
    it('opens as a pane of its own on an empty layout, drops the one-shot parameter and keeps the rest of the address', async () => {
      renderRoute('/?open=todos&view=x')

      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?view=x'))
      expect(await screen.findByTestId('todos-board-stub')).toBeTruthy()
      // No chat opens behind it, and no composer beside it.
      expect(chatPanes()).toEqual([])
      expect(composerPanes()).toHaveLength(0)
      expect(storedGroups().map((group) => group.tabs)).toEqual([['todos:']])
    })

    it('waits for the stored layout instead of landing in the one it is about to replace', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }])
      renderRoute('/?open=todos')

      // The tab joined the restored layout, in the focused pane, and the route went to that pane's chat.
      await waitFor(() => expect(storedGroups().map((group) => group.tabs)).toEqual([['a', 'todos:'], ['b']]))
      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=a'))
      expect(chatPanes().sort()).toEqual(['a', 'b'])
      expect(await screen.findByTestId('todos-board-stub')).toBeTruthy()
    })

    it('opens beside the chat of the focused pane, and leaves the route on that chat', async () => {
      seedLayout([{ tabs: ['b'] }, { tabs: ['a'] }], { focused: 1 })
      renderRoute('/?session=a&open=todos')

      await waitFor(() => expect(storedGroups().map((group) => group.tabs)).toEqual([['b'], ['a', 'todos:']]))
      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=a'))
    })

    it('keeps the route on a chat when it opens the tab in a pane of its own beside chats, with no blank composer beside them', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }], { focused: 1 })
      renderRoute('/?open=todos')

      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=a'))
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      await settled()
      expect(chatPanes()).toEqual(['a'])
      expect(composerPanes()).toHaveLength(0)
    })

    it('is one tab however often it is opened: the second open shows it where it is', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }])
      renderRoute('/?session=a')
      await waitFor(() => expect(chatPanes().sort()).toEqual(['a', 'b']))

      fireEvent.click(railLink('Todos'))
      await waitFor(() => expect(todosPanes().length + document.querySelectorAll('[data-pane-tab-id="todos:"]').length).toBeGreaterThan(0))
      fireEvent.click(railLink('Todos'))
      await settled()

      expect(storedGroups().flatMap((group) => group.tabs).filter((id) => id === 'todos:')).toHaveLength(1)
      // The nav link opened it in place: no navigation to the route it is already on.
      expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
    })
  })

  describe('with only standalone tabs', () => {
    it('shows the Todos pane alone, with no route composer, and shows it again after a reload', async () => {
      seedLayout([{ tabs: ['todos:'] }])
      const first = renderRoute('/')

      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      await settled()
      expect(composerPanes()).toHaveLength(0)
      expect(chatPanes()).toEqual([])
      expect(screen.getByTestId('route-location').textContent).toBe('/')
      // It is the lone pane: its own title bar names it.
      expect(within(document.querySelector<HTMLElement>('[data-testid="doc-pane-title"]')!).getByText('Todos')).toBeTruthy()
      first.unmount()

      renderRoute('/')
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      await settled()
      // The newest chat the bare route would open stays closed.
      expect(chatPanes()).toEqual([])
      expect(screen.getByTestId('route-location').textContent).toBe('/')
    })

    it('shows a pinned document the same way', async () => {
      seedLayout([{ tabs: ['todo:ACM-1'] }], { pinned: ['todo:ACM-1'] })
      renderRoute('/')

      await waitFor(() => expect(document.querySelectorAll('[data-doc-pane-kind="todo"]')).toHaveLength(1))
      await settled()
      expect(composerPanes()).toHaveLength(0)
    })

    it('opens a new chat as a composer beside the Todos pane', async () => {
      seedLayout([{ tabs: ['todos:'] }])
      renderRoute('/')
      await waitFor(() => expect(todosPanes()).toHaveLength(1))

      fireEvent.click(screen.getAllByRole('button', { name: 'Start empty chat' })[0])

      await waitFor(() => expect(document.querySelectorAll('[data-chat-grid-pane^="new:"]')).toHaveLength(1))
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      expect(storedGroups().map((group) => group.tabs)).toEqual([['todos:'], [expect.stringMatching(/^new:/)]])
    })

    it('opens a chat chosen from the list beside the Todos pane rather than inside it', async () => {
      seedLayout([{ tabs: ['todos:'] }])
      renderRoute('/?session=a')

      await waitFor(() => expect(chatPanes()).toEqual(['a']))
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      expect(storedGroups().map((group) => group.tabs)).toEqual([['todos:'], ['a']])
    })

    it('stays on screen when the last chat closes beside it', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }])
      renderRoute('/?session=a')
      await waitFor(() => expect(chatPanes()).toEqual(['a']))
      await waitFor(() => expect(todosPanes()).toHaveLength(1))

      fireEvent.click(await within(document.querySelector<HTMLElement>('[data-chat-pane-session="a"]')!).findByRole('button', { name: 'Close Title a' }))

      await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/'))
      await waitFor(() => expect(chatPanes()).toEqual([]))
      expect(todosPanes()).toHaveLength(1)
      expect(composerPanes()).toHaveLength(0)
    })
  })

  describe('the nav', () => {
    const current = (name: string) => railLink(name).getAttribute('aria-current')

    it('marks Todos while its tab is the focused one, and Chat while a chat is', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }])
      renderRoute('/?session=a')
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      await waitFor(() => expect(current('Chat')).toBe('page'))
      expect(current('Todos')).toBeNull()

      fireEvent.click(document.querySelector('[data-doc-pane-kind="todos"]')!)
      await waitFor(() => expect(current('Todos')).toBe('page'))
      expect(current('Chat')).toBeNull()

      fireEvent.click(document.querySelector('[data-chat-pane-session="a"]')!)
      await waitFor(() => expect(current('Chat')).toBe('page'))
      expect(current('Todos')).toBeNull()
    })

    it('takes the Chat icon from the Todos tab to a chat of the layout, and Chat becomes current', async () => {
      seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }])
      renderRoute('/?session=a')
      await waitFor(() => expect(todosPanes()).toHaveLength(1))
      fireEvent.click(document.querySelector('[data-doc-pane-kind="todos"]')!)
      await waitFor(() => expect(current('Todos')).toBe('page'))

      fireEvent.click(railLink('Chat'))

      await waitFor(() => expect(current('Chat')).toBe('page'))
      expect(current('Todos')).toBeNull()
      expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
    })

    it('points the Todos item at the chat route with the open parameter', () => {
      renderRoute('/?session=a')
      expect(railLink('Todos').getAttribute('href')).toBe('/?open=todos')
    })
  })
})
