import "@/test/preload-menus"
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { SPLIT_LAYOUT_STORAGE_KEY } from '../layout/split-layout-storage'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'
import { apiMocks, chatTabsMock, gateway, openChatBeside, pane, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'

/** The tabs the layout owns on desktop, and the phone's own strip, are separate stores; a close-all
 *  has to leave both empty, because that is what a reload reads them back from. */
function seedWorkingSet(ids = sessionIds) {
  localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ids, focusedId: ids[0], focusHistory: ids }))
}

function stored(key: string): Record<string, unknown> {
  const raw = localStorage.getItem(key)
  if (!raw) throw new Error(`nothing stored under ${key}`)
  return JSON.parse(raw) as Record<string, unknown>
}

/** The panes still carrying a chat, and the composer pane that is the app's empty state. */
const sessionPanes = () => document.querySelectorAll('[data-chat-pane-session]:not([data-chat-pane-session="new"])')
const composerPane = () => document.querySelector('[data-chat-pane-session="new"]')

/**
 * Presses the close-all the tab bars carry. Exactly one is on screen at a time: the focused pane's
 * strip when it shows tabs, that pane's title bar when it shows one, and the phone's strip.
 */
async function pressCloseAll() {
  // The composer takes focus a frame after a chat opens, which can move the button between bars.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const buttons = await screen.findAllByRole('button', { name: 'Close all tabs' })
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
}

describe('closing every tab from the tab bar', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
  })

  it('closes every pane, lands on the bare route, and clears the stored layout and working set', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    await pressCloseAll()

    await waitFor(() => expect(sessionPanes()).toHaveLength(0))
    expect(composerPane()).not.toBeNull()
    expect(screen.getByTestId('route-location').textContent).toBe('/')
    // What a reload hydrates from: no panes, nobody to reopen.
    expect(stored(SPLIT_LAYOUT_STORAGE_KEY).root).toBeNull()
    expect(stored(WORKING_SET_STORAGE_KEY).sessionIds).toEqual([])
  })

  it('does not let the sidebar auto-select put a chat back in the emptied layout', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    await pressCloseAll()
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/'))
    // Give a late auto-select every chance to fire before calling the empty state stable.
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(sessionPanes()).toHaveLength(0)
    expect(composerPane()).not.toBeNull()
    expect(screen.getByTestId('route-location').textContent).toBe('/')
    expect(stored(SPLIT_LAYOUT_STORAGE_KEY).root).toBeNull()
  })

  it('closes the phone strip as well, leaving the chat list and an empty stored tab list', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    renderRoute('/')

    const openFromList = async (id: string) => {
      fireEvent.click(await screen.findByTestId(`list-row-${id}`))
      await waitFor(() => expect(pane(id)).toBeDefined())
    }
    await openFromList('a')
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
    await openFromList('c')
    await waitFor(() => expect(document.querySelector('[data-mobile-session-tabs]')).not.toBeNull())
    expect(stored(MOBILE_TABS_STORAGE_KEY).sessionIds).toEqual(['a', 'c'])

    await pressCloseAll()

    await waitFor(() => expect(document.querySelector('[data-mobile-session-tabs]')).toBeNull())
    expect(stored(MOBILE_TABS_STORAGE_KEY).sessionIds).toEqual([])
    // The phone's empty state is the chat list, not a thread with nothing in it.
    expect(screen.getByTestId('route-location').textContent).toBe('/')
  })

  it('closes the beside-picker too, leaving one composer rather than two', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    await openChatBeside()
    await waitFor(() => expect(document.querySelector('[data-testid="session-picker-search"]')).not.toBeNull())

    await pressCloseAll()
    await waitFor(() => expect(sessionPanes()).toHaveLength(0))
    expect(document.querySelector('[data-testid="session-picker-search"]')).toBeNull()
    expect(document.querySelectorAll('[data-chat-pane-session="new"]')).toHaveLength(1)
  })

  it('offers the close in the strip while only the phone strip is holding tabs', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    // No pane and no open-chats tab, but the strip is holding two chats the list does not carry:
    // a phone reaches this by archiving its panes while the strip's tabs survive (the strip keeps
    // archived chats' tabs deliberately). The strip is the only thing holding a tab, so its own
    // button is the only way to close them — and it is there.
    sessionIds.splice(0, sessionIds.length)
    chatTabsMock.tabs = []
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['zz', 'yy'] }))
    renderRoute('/')

    fireEvent.click(await screen.findByText('Start empty chat'))
    await waitFor(() => expect(document.querySelector('[data-mobile-session-tabs]')).not.toBeNull())
    expect(document.querySelectorAll('[data-mobile-session-tab]')).toHaveLength(2)

    const closeAll = document.querySelector('[data-close-all-tabs]')
    expect(closeAll).not.toBeNull()
    expect(closeAll!.closest('[data-mobile-session-tabs]')).not.toBeNull()

    fireEvent.click(closeAll!)
    await waitFor(() => expect(document.querySelector('[data-mobile-session-tabs]')).toBeNull())
    expect(stored(MOBILE_TABS_STORAGE_KEY).sessionIds).toEqual([])
  })

  it('carries the close once, in the focused pane\'s bar rather than in every pane', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    // Four panes, each holding one tab, so no strip is drawn: the focused pane's title bar is the
    // tab bar in that state, and it is the only one that carries the action.
    const buttons = document.querySelectorAll('[data-close-all-tabs]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].closest('[data-chat-pane-titlebar="true"]')).not.toBeNull()
  })

  it('asks the open-chats list to clear itself, which is what empties jinn-chat-tabs', async () => {
    // The list the page reads is mocked here, so this pins the call; use-chat-tabs.test.ts pins that
    // the call empties the stored key. Removing either half leaves a reload that still has tabs.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    await pressCloseAll()
    expect(chatTabsMock.closeAllTabs).toHaveBeenCalledTimes(1)
  })
})
