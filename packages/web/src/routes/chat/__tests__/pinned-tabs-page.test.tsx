import "@/test/preload-menus"
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../layout/split-layout-storage'
import { apiMocks, chatTabsMock, gateway, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'

interface SeedGroup { tabs: string[]; activeTab?: string }

/** The pane tree a reload restores: one group per entry, the first focused, with `pinned` pinned. */
function seedLayout(groups: SeedGroup[], pinned: string[]) {
  const children = groups.map(({ tabs, activeTab }, index) => ({ type: 'group', id: `g${index + 1}`, tabs, activeTab: activeTab ?? tabs[0] }))
  const root = children.length === 1
    ? children[0]
    : { type: 'split', id: 's1', direction: 'row', children, sizes: children.map(() => 1 / children.length) }
  localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify({
    version: 1, auto: false, focusedGroupId: 'g1', focusHistory: groups.flatMap((g) => g.tabs), nextId: 9, root, pinned,
  }))
}

function storedLayout(): { root: unknown; pinned: string[] } {
  return JSON.parse(localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? '{}')
}

const panes = () => [...document.querySelectorAll('[data-chat-pane-session]:not([data-chat-pane-session="new"])')].map((node) => node.getAttribute('data-chat-pane-session'))

async function pressCloseAll() {
  await new Promise((resolve) => setTimeout(resolve, 60))
  fireEvent.click(await screen.findByRole('button', { name: 'Close all tabs' }))
}

const strip = () => document.querySelector<HTMLElement>('[data-testid="pane-tab-strip"]')!
const tabIds = () => [...strip().querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('data-pane-tab-id'))

describe('pinned tabs on the chat page', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
  })

  it('close all keeps a pinned chat, tells the open-chats list to keep it, and follows the route to it', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }, { tabs: ['c'] }], ['b'])
    renderRoute('/?session=a')
    await waitFor(() => expect(panes()).toEqual(['a', 'b', 'c']))

    await pressCloseAll()

    await waitFor(() => expect(panes()).toEqual(['b']))
    expect(chatTabsMock.closeAllTabs).toHaveBeenCalledWith(['b'])
    expect(screen.getByTestId('route-location').textContent).toBe('/?session=b')
    expect(storedLayout().pinned).toEqual(['b'])
  })

  it('close all leaves the route alone when its chat is the pinned one', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }], ['a'])
    renderRoute('/?session=a')
    await waitFor(() => expect(panes()).toEqual(['a', 'b']))

    await pressCloseAll()

    await waitFor(() => expect(panes()).toEqual(['a']))
    expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
  })

  it('offers no close all when every open tab is pinned', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }], ['a', 'b'])
    chatTabsMock.tabs = seededChatTabs().filter((tab) => ['a', 'b'].includes(tab.sessionId))
    renderRoute('/?session=a')
    await waitFor(() => expect(panes()).toEqual(['a', 'b']))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.queryByRole('button', { name: 'Close all tabs' })).toBeNull()
  })

  it('draws no close button on the pane of a pinned chat, and one on the pane of an unpinned chat', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }], ['a'])
    renderRoute('/?session=a')
    await waitFor(() => expect(panes()).toEqual(['a', 'b']))
    const closeOf = (id: string) => document.querySelector(`[data-chat-pane-session="${id}"] [aria-label^="Close "]:not([data-close-all-tabs])`)
    expect(closeOf('a')).toBeNull()
    expect(closeOf('b')).not.toBeNull()
    expect(document.querySelector('[data-chat-pane-session="a"] [data-pane-tab-unpin]')).not.toBeNull()
  })

  it('pins a lone chat from its title bar menu, and unpins it again', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }], [])
    renderRoute('/?session=a')
    await waitFor(() => expect(panes()).toEqual(['a', 'b']))
    const bar = () => document.querySelector<HTMLElement>('[data-chat-pane-session="b"] [data-testid="chat-pane-title-bar"]')!

    fireEvent.contextMenu(bar(), { clientX: 20, clientY: 20 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin tab' }))
    await waitFor(() => expect(storedLayout().pinned).toEqual(['b']))

    fireEvent.contextMenu(bar(), { clientX: 20, clientY: 20 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Unpin tab'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin tab' }))
    await waitFor(() => expect(storedLayout().pinned).toEqual([]))
  })

  it('Cmd+W closes the shown tab unless it is pinned', async () => {
    seedLayout([{ tabs: ['a', 'b'], activeTab: 'a' }], ['a'])
    renderRoute('/?session=a')
    await waitFor(() => expect(tabIds()).toEqual(['a', 'b']))

    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(tabIds()).toEqual(['a', 'b'])

    const tabB = () => strip().querySelector<HTMLElement>('[data-pane-tab-id="b"]')!
    fireEvent.click(tabB())
    await waitFor(() => expect(tabB().getAttribute('aria-selected')).toBe('true'))
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    // Only the pinned tab is left, so its group has no strip any more.
    await waitFor(() => expect(document.querySelector('[data-testid="pane-tab-strip"]')).toBeNull())
    expect(storedLayout().pinned).toEqual(['a'])
  })
})
