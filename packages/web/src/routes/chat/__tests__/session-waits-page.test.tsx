import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { persistSplitLayout } from '../layout/split-layout-storage'
import { createSplitLayout } from '../layout/split-layout'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'
import type { DelegatedSessionWait } from '@/lib/session-waits'

/** Chat `a` is waiting on two delegated chats: `b`, open beside it, and `e`, which has no tab. */
function waitingChild(sessionId: string, name: string): DelegatedSessionWait {
  return {
    kind: 'session', sessionId, reportsTo: 'a', relation: 'delegated', restricted: false,
    employee: name.toLowerCase(), employeeDisplayName: name, title: null,
    todo: { id: 'PLA-1', title: `Work for ${name}` }, status: 'running', active: true,
    since: new Date(Date.now() - 4 * 60_000).toISOString(), endedAt: null, archived: false,
  }
}

const DELEGATED = { activeSessions: 2, employees: ['beta', 'echo'] }

function seed(): void {
  persistSplitLayout(localStorage, createSplitLayout(['a', 'b'], 'a'))
  localStorage.removeItem(WORKING_SET_STORAGE_KEY)
  const detail = (id: string) => ({
    id, title: `Title ${id}`, status: 'idle', engine: 'claude', engineSessionId: `engine-${id}`,
    delegatedActivity: id === 'a' ? DELEGATED : null,
    messages: [{ id: `${id}-m1`, role: 'assistant', content: `transcript-${id}`, timestamp: 1 }],
  })
  apiMocks.getSession.mockImplementation(async (id: string) => detail(id) as never)
  apiMocks.getSessions.mockImplementation(async () => ({
    sessions: sessionIds.map((id) => ({ id, title: `Title ${id}`, status: 'idle', delegatedActivity: id === 'a' ? DELEGATED : null })),
    counts: {},
    perGroup: {},
  }))
  apiMocks.getSessionWaits.mockImplementation(async (id: string) => ({
    sessionId: id,
    generatedAt: new Date().toISOString(),
    items: id === 'a' ? [waitingChild('b', 'Beta'), waitingChild('e', 'Echo')] : [],
  }))
}

async function openWaitsPopup(): Promise<HTMLElement> {
  const trigger = await screen.findByTestId('background-activity-trigger')
  // The composer takes focus when the pane mounts; a popup opened before that would be dismissed by it.
  await waitFor(() => expect(document.activeElement?.tagName).toBe('TEXTAREA'))
  fireEvent.click(trigger)
  return screen.findByRole('dialog')
}

const route = () => screen.getByTestId('route-location').textContent

describe('the waiting-on popup in the chat layout', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd', 'e')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    seed()
  })

  it("opens a delegated child that has no tab as the sessions list does, and back returns to the parent", async () => {
    renderRoute('/?session=a')
    const popup = await openWaitsPopup()
    expect(route()).toBe('/?session=a')

    fireEvent.click(await within(popup).findByRole('button', { name: /Echo/ }))

    await waitFor(() => expect(route()).toBe('/?session=e'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.getByText('transcript-e')).toBeTruthy())

    fireEvent.click(screen.getByText('Test browser back'))

    await waitFor(() => expect(route()).toBe('/?session=a'))
    expect(screen.getByText('transcript-a')).toBeTruthy()
  })

  it('focuses a delegated child that is already open beside the parent, and back returns to the parent', async () => {
    renderRoute('/?session=a')
    const popup = await openWaitsPopup()

    fireEvent.click(await within(popup).findByRole('button', { name: /Beta/ }))

    await waitFor(() => expect(route()).toBe('/?session=b'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(screen.getByText('Test browser back'))

    await waitFor(() => expect(route()).toBe('/?session=a'))
    expect(screen.getByText('transcript-a')).toBeTruthy()
  })
})
