import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../layout/split-layout-storage'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'
import { apiMocks, chatTabsMock, gateway, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'

// The board has its own suites; here it is a stand-in that says it is on screen.
vi.mock('@/routes/todos/board/todos-tab-view', () => ({ default: () => <div data-testid="todos-board-stub" /> }))

interface SeedGroup { tabs: string[]; activeTab?: string }

/** The pane tree a reload restores: one group per entry, `focused` (the first by default) holding focus. */
function seedLayout(groups: SeedGroup[], { pinned = [], focused = 0 }: { pinned?: string[]; focused?: number } = {}) {
  const children = groups.map(({ tabs, activeTab }, index) => ({ type: 'group', id: `g${index + 1}`, tabs, activeTab: activeTab ?? tabs[0] }))
  const root = children.length === 1
    ? children[0]
    : { type: 'split', id: 's1', direction: 'row', children, sizes: children.map(() => 1 / children.length) }
  localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1, auto: false, focusedGroupId: `g${focused + 1}`, focusHistory: groups.flatMap((g) => g.tabs), nextId: 9, root, pinned,
  }))
}

interface StoredGroup { type: 'group'; tabs: string[] }
function storedGroups(): StoredGroup[] {
  const root = JSON.parse(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? '{}').root as { type: string; children?: StoredGroup[] } | undefined
  if (!root) return []
  return root.type === 'group' ? [root as StoredGroup] : root.children ?? []
}

const todosPanes = () => document.querySelectorAll('[data-doc-pane-kind="todos"]')
const chatPanes = () => [...document.querySelectorAll('[data-chat-pane-session]:not([data-chat-pane-session="new"])')].map((node) => node.getAttribute('data-chat-pane-session'))
const composerPanes = () => document.querySelectorAll('[data-chat-pane-session="new"]')
const settled = () => new Promise((resolve) => setTimeout(resolve, 80))
const railLink = (name: string) => within(document.querySelector<HTMLElement>('nav[aria-label="Primary"]')!).getByRole('link', { name })

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

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

    it('points the Todos item at the chat route with the open parameter', () => {
      renderRoute('/?session=a')
      expect(railLink('Todos').getAttribute('href')).toBe('/?open=todos')
    })
  })

  describe('on a phone', () => {
    beforeEach(() => setViewport(390, 844))

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
  })
})
