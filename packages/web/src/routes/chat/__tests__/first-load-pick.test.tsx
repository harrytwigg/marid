import "@/test/preload-menus"
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { apiMocks, chatTabsMock, gateway, listLoadGate, renderDataRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, settled, setViewport } from './todos-tab-page-support'

// A tap can land while the page is still loading: before the list has reported its first load (which the page
// primes the newest chat from), or before the page's first effects have run. A loaded host does both by chance;
// these tests put the tap there on every run.
const routeLocation = () => screen.getByTestId('route-location').textContent
const routeState = () => JSON.parse(screen.getByTestId('route-state').textContent || 'null')
const stripTab = (id: string) => document.querySelector<HTMLElement>(`[data-mobile-session-tab="${id}"]`)

// A row committed to the page can be tapped before the page's effects for that commit have run: they run
// from a later task, and a loaded host gets to the tap first. Watching for the row and tapping it in the
// same turn puts the tap in that gap on every run.
function tapAsSoonAsShown(id: string) {
  const observer = new MutationObserver(() => {
    const row = document.querySelector<HTMLElement>(`[data-testid="list-row-${id}"]`)
    if (!row) return
    observer.disconnect()
    fireEvent.click(row)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

async function tapBeforeTheListReports(id: string) {
  listLoadGate.hold = true
  renderDataRoute('/')
  const row = await screen.findByTestId(`list-row-${id}`)
  await waitFor(() => expect(listLoadGate.held).toHaveLength(1))
  // The report arrives while the tap's navigation is still on its way: the route has not landed yet.
  await act(async () => {
    fireEvent.click(row)
    listLoadGate.hold = false
    listLoadGate.held.splice(0).forEach((report) => report())
  })
  await waitFor(() => expect(routeLocation()).toMatch(/^\/\?session=/))
  await settled()
}

describe('a chat tapped while the page is still loading', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    setViewport(390, 844)
  })
  afterEach(() => {
    listLoadGate.hold = false
    listLoadGate.held.length = 0
  })

  it('is not replaced by the newest chat the list\'s first load then primes', async () => {
    await tapBeforeTheListReports('b')

    expect(routeLocation()).toBe('/?session=b')
    await waitFor(() => expect(chatPanes()).toEqual(['b']))
  })

  it('keeps a chat tapped before the page has run its first effects as one the reader chose', async () => {
    const stop = tapAsSoonAsShown('a')
    renderDataRoute('/')
    await waitFor(() => expect(routeLocation()).toBe('/?session=a'))
    stop()
    await waitFor(() => expect(chatPanes()).toContain('a'))
    await settled()
    expect(routeLocation()).toBe('/?session=a')

    // A chat the reader opened earns a tab on the phone's strip; one the page picked by itself does not.
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
    fireEvent.click(await screen.findByTestId('list-row-b'))
    await waitFor(() => expect(routeLocation()).toBe('/?session=b'))
    await waitFor(() => expect(chatPanes()).toContain('b'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Todos' }))
    await screen.findByTestId('phone-todos')
    await waitFor(() => expect(routeState()).toMatchObject({ phoneTodos: true }))

    await waitFor(() => expect(stripTab('a')).toBeTruthy())
    expect(stripTab('b')).toBeTruthy()
  })
})
