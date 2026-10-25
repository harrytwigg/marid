import "@/test/preload-menus"
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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

/** Opens the More menu of whichever copy is on screen (desktop pill or phone nav bar). */
async function openMoreMenu(): Promise<HTMLElement> {
  // The composer takes focus a frame after a chat opens, which would close a menu opened before it.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const actions = screen.getAllByRole('button', { name: 'New chat' })[0].parentElement!
  fireEvent.pointerDown(within(actions).getByRole('button', { name: 'More options' }), { button: 0, ctrlKey: false })
  return (await screen.findAllByRole('menuitem', { name: 'Close all tabs' }))[0]
}

async function closeAllFromMoreMenu() {
  fireEvent.click(await openMoreMenu())
}

describe('closing every tab from the header menu', () => {
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

    await closeAllFromMoreMenu()

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

    await closeAllFromMoreMenu()
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

    await closeAllFromMoreMenu()

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

    await closeAllFromMoreMenu()
    await waitFor(() => expect(sessionPanes()).toHaveLength(0))
    expect(document.querySelector('[data-testid="session-picker-search"]')).toBeNull()
    expect(document.querySelectorAll('[data-chat-pane-session="new"]')).toHaveLength(1)
  })

  it('stays offered while only the phone strip is holding tabs', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
    // No pane and no open-chats tab, but the strip is holding two chats the list does not carry:
    // a phone reaches this by archiving its panes while the strip's tabs survive (the strip keeps
    // archived chats' tabs deliberately). The strip is then the only thing holding a tab, and the
    // control that closes them must not be greyed out.
    sessionIds.splice(0, sessionIds.length)
    chatTabsMock.tabs = []
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['zz', 'yy'] }))
    renderRoute('/')

    fireEvent.click(await screen.findByText('Start empty chat'))
    await waitFor(() => expect(document.querySelector('[data-mobile-session-tabs]')).not.toBeNull())
    expect(document.querySelectorAll('[data-mobile-session-tab]')).toHaveLength(2)

    const item = await openMoreMenu()
    expect(item.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('asks the open-chats list to clear itself, which is what empties jinn-chat-tabs', async () => {
    // The list the page reads is mocked here, so this pins the call; use-chat-tabs.test.ts pins that
    // the call empties the stored key. Removing either half leaves a reload that still has tabs.
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    await closeAllFromMoreMenu()
    expect(chatTabsMock.closeAllTabs).toHaveBeenCalledTimes(1)
  })
})
