import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { apiMocks, gateway, pane, renderRoute, sessionIds } from './multi-pane-page-harness'

const writeText = vi.fn().mockResolvedValue(undefined)

describe('desktop pane focus', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.deleteSession.mockClear()
    apiMocks.duplicateSession.mockClear()
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
  })

  it('keeps menu actions pane-owned while shortcuts remain focus-owned', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    expect(document.querySelectorAll('[data-chat-pane-menu-trigger]')).toHaveLength(4)

    const paneC = pane('c')
    fireEvent.pointerDown(within(paneC).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(pane('a').getAttribute('data-chat-pane-active')).toBe('true')
    expect(paneC.getAttribute('data-chat-pane-active')).toBe('false')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy Session ID' }))
    expect(writeText).toHaveBeenCalledWith('c')
    expect(await within(paneC).findByTestId('chat-pane-copy-toast')).toBeTruthy()
    expect(pane('a').getAttribute('data-chat-pane-active')).toBe('true')

    fireEvent.pointerDown(within(paneC).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete session' }))
    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenNthCalledWith(1, 'c'))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="c"]')).toBeNull())

    fireEvent.keyDown(window, { key: 'Backspace' })
    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenNthCalledWith(2, 'a'))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull())
    await waitFor(() => expect(pane('b').getAttribute('data-chat-pane-active')).toBe('true'))
    await waitFor(() => expect(document.querySelectorAll('[data-chat-grid-pane][aria-current="true"]')).toHaveLength(1))
    const persisted = JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}')
    expect(persisted.sessionIds).not.toContain('a')
    expect(persisted.focusedId).toBe('b')

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
    await waitFor(() => expect(pane('b').getAttribute('data-chat-pane-active')).toBe('true'))
  })

  it('gives the deleted slot to the fallback instead of a surviving sibling', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    // The working set is a SUBSET of the sidebar order, so the post-delete
    // fallback ('b') is a chat that was never in the grid — the original repro.
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a', 'c', 'd'],
      focusedId: 'a',
      focusHistory: ['c', 'd', 'a'],
    }))
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(3))

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    fireEvent.keyDown(window, { key: 'Backspace' })
    await waitFor(() => expect(apiMocks.deleteSession).toHaveBeenCalledWith('a'))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="b"]')).not.toBeNull())

    expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull()
    expect(document.querySelector('[data-chat-pane-session="c"]')).not.toBeNull()
    expect(document.querySelector('[data-chat-pane-session="d"]')).not.toBeNull()
    const persisted = JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}')
    expect(persisted.sessionIds).toEqual(['b', 'c', 'd'])
    expect(persisted.focusedId).toBe('b')
  })

  it('surfaces a pane duplicate instead of completing silently', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))

    fireEvent.pointerDown(within(pane('c')).getByRole('button', { name: 'Actions for Title c' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Duplicate/ }))

    await waitFor(() => expect(apiMocks.duplicateSession).toHaveBeenCalledWith('c'))
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toContain('session=c-copy'))
    await waitFor(() => expect(pane('c-copy').getAttribute('data-chat-pane-active')).toBe('true'))
  })

  it('keeps every displaced header action reachable from each pane menu', async () => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b')
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds,
      focusedId: 'a',
      focusHistory: sessionIds,
    }))
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(2))
    expect(document.querySelector('[data-chat-desktop-actions]')).toBeNull()

    const paneB = pane('b')
    fireEvent.pointerDown(within(paneB).getByRole('button', { name: 'Actions for Title b' }), { button: 0, ctrlKey: false })
    let menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Open beside' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Open in new tab' })).toBeTruthy()
    expect(within(menu).getByRole('menuitemradio', { name: 'Chat' })).toBeTruthy()
    expect(within(menu).getByRole('menuitemradio', { name: 'CLI' })).toBeTruthy()
    // The pane title bar is the multi-pane home of the header's Open beside, so it has to
    // read the same and sit in the same slot: view toggle first, then Open beside, then the
    // session items. An earlier change introduced it above the toggle under a different name.
    const paneMenuOrder = Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button'))
      .map((element) => element.textContent?.trim() ?? '')
    expect(paneMenuOrder.indexOf('Open beside')).toBe(paneMenuOrder.indexOf('CLI') + 1)
    expect(paneMenuOrder.indexOf('Open in new tab')).toBe(paneMenuOrder.indexOf('Open beside') + 1)
    expect(paneMenuOrder.indexOf('Open beside')).toBeLessThan(paneMenuOrder.indexOf('Rename'))
    expect(within(menu).getByRole('menuitem', { name: 'Copy CLI Resume Command' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Share debug log' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Clear debug log' })).toBeTruthy()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'CLI' }))
    await waitFor(() => expect(localStorage.getItem('jinn-view-mode-b')).toBe('cli'))
    await waitFor(() => expect(paneB.textContent).not.toContain('transcript-b'))

    fireEvent.pointerDown(within(paneB).getByRole('button', { name: 'Actions for Title b' }), { button: 0, ctrlKey: false })
    menu = await screen.findByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Chat' }))
    await waitFor(() => expect(localStorage.getItem('jinn-view-mode-b')).toBe('chat'))
    await waitFor(() => expect(paneB.textContent).toContain('transcript-b'))
  })

  it('moves the single selected treatment with click and j/k navigation', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    const selected = () => document.querySelectorAll('[data-chat-grid-pane][aria-current="true"]')
    await waitFor(() => expect(selected()).toHaveLength(1))
    expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('a')

    fireEvent.click(pane('c'))
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('c'))
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('d'))
    fireEvent.keyDown(window, { key: 'k' })
    await waitFor(() => expect(selected()[0].getAttribute('data-chat-grid-pane')).toBe('c'))
  })
})
