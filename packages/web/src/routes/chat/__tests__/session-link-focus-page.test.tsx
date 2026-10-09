import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { loadSplitLayout, persistSplitLayout } from '../layout/split-layout-storage'
import { createSplitLayout, focusedGroup, groupOfSession, openDocTab } from '../layout/split-layout'
import { todoTabId } from '../layout/tab-kind'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'

/** A Todo shown as a tab holds the session links the operator clicks; here, three of them. */
vi.mock('@/components/chat/doc-view', async () => {
  const { useOpenSession } = await import('@/components/chat/file-open-context')
  return {
    DocView: () => {
      const open = useOpenSession()
      return (
        <div data-testid="doc-view-probe">
          {['a', 'b', 'e'].map((id) => <button key={id} type="button" data-testid={`session-link-${id}`} onClick={() => open(id)} />)}
        </div>
      )
    },
  }
})

const TODO = todoTabId('PLA-1')

function seedLayout(): void {
  // Chats a and b side by side, the Todo opened over a, which holds focus.
  const layout = openDocTab(createSplitLayout(['a', 'b'], 'a'), 'a', TODO)
  persistSplitLayout(localStorage, layout)
  localStorage.removeItem(WORKING_SET_STORAGE_KEY)
}

const stored = () => loadSplitLayout(localStorage)

describe('a session link inside the chat layout', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd', 'e')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.getSessions.mockClear()
    seedLayout()
  })

  it('shows the chat that is already the route\'s when a Todo is shown over it', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('doc-view-probe')).toBeTruthy())
    expect(groupOfSession(stored(), 'a')!.activeTab).toBe(TODO)

    fireEvent.click(screen.getByTestId('session-link-a'))

    await waitFor(() => expect(groupOfSession(stored(), 'a')!.activeTab).toBe('a'))
    expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
    expect(screen.queryByTestId('doc-view-probe')).toBeNull()
  })

  it('focuses the pane of a chat open in another group', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('doc-view-probe')).toBeTruthy())
    expect(focusedGroup(stored())!.tabs).toContain(TODO)

    fireEvent.click(screen.getByTestId('session-link-b'))

    await waitFor(() => expect(focusedGroup(stored())!.tabs).toEqual(['b']))
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=b'))
    expect(groupOfSession(stored(), 'a')!.activeTab).toBe(TODO)
  })

  it('opens a chat that has no tab as it opens from the list', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('doc-view-probe')).toBeTruthy())
    expect(groupOfSession(stored(), 'e')).toBeNull()

    fireEvent.click(screen.getByTestId('session-link-e'))

    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=e'))
    await waitFor(() => expect(groupOfSession(stored(), 'e')).not.toBeNull())
  })
})
