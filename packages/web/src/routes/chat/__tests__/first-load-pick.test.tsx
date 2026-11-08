import "@/test/preload-menus"
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { apiMocks, chatTabsMock, gateway, listLoadGate, renderDataRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, settled, setViewport } from './todos-tab-page-support'

// The page primes the newest chat once the list reports its first load, and the list reports it from a
// transition, so a tap can land first: on a loaded host it does. The gate holds the report until after the tap,
// which puts the tap first on every run.
const routeLocation = () => screen.getByTestId('route-location').textContent
const stripTabs = () => [...document.querySelectorAll('[data-mobile-session-tab]')].map((node) => node.getAttribute('data-mobile-session-tab'))

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

describe('a chat tapped before the list has reported its first load', () => {
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

  it('is not replaced by the newest chat the load then primes', async () => {
    await tapBeforeTheListReports('b')

    expect(routeLocation()).toBe('/?session=b')
    await waitFor(() => expect(chatPanes()).toEqual(['b']))
  })

  it('still earns a tab when it is the newest chat itself', async () => {
    await tapBeforeTheListReports('a')
    await waitFor(() => expect(chatPanes()).toEqual(['a']))
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to chats' })[0])
    fireEvent.click(await screen.findByTestId('list-row-b'))
    await waitFor(() => expect(routeLocation()).toBe('/?session=b'))

    await waitFor(() => expect(stripTabs()).toEqual(['a', 'b']))
  })
})
