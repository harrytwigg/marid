import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { loadSplitLayout, persistSplitLayout } from '../layout/split-layout-storage'
import { createSplitLayout, focusedGroup, groupOfSession, openDocTab } from '../layout/split-layout'
import { todoTabId } from '../layout/tab-kind'
import { gateway, renderRoute, sessionIds } from './multi-pane-page-harness'

/** A Todo shown as a tab whose session tree names another Todo, already open over the other chat. */
vi.mock('@/components/chat/doc-view', async () => {
  const { SessionTreePanel } = await import('@/routes/todos/task-page/session-tree')
  const child = {
    id: 's-2', employee: null, status: 'idle', title: null, role: 'execute', workItemId: 'PLA-2', isRootLink: false,
    archived: false, backgroundActivity: null, delegatedActivity: null, truncated: null, children: [],
  }
  const tree = {
    roots: [{ ...child, id: 's-1', workItemId: 'PLA-1', isRootLink: true, children: [child] }],
    directory: {}, truncated: { depth: false, count: false }, totals: { nodes: 2, live: 0 },
  }
  return {
    DocView: ({ doc }: { doc: { kind: string; todoId?: string } }) => doc.kind === 'todo' && doc.todoId === 'PLA-1'
      ? <SessionTreePanel tree={tree as never} byName={new Map()} todoId="PLA-1" />
      : null,
  }
})

const OVER_A = todoTabId('PLA-1')
const OVER_B = todoTabId('PLA-2')

function seedLayout(): void {
  // Chats a and b side by side, PLA-2 open over b, PLA-1 over a, which holds focus.
  const layout = openDocTab(openDocTab(createSplitLayout(['a', 'b'], 'b'), 'b', OVER_B), 'a', OVER_A)
  persistSplitLayout(localStorage, layout)
  localStorage.removeItem(WORKING_SET_STORAGE_KEY)
}

const stored = () => loadSplitLayout(localStorage)

describe("a session tree's Todo link inside the chat layout", () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    seedLayout()
  })

  it('focuses the Todo\'s tab where it is already open, and the pane it was clicked in does not take focus back', async () => {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('session-tree-todo-s-2')).toBeTruthy())
    expect(focusedGroup(stored())!.activeTab).toBe(OVER_A)

    fireEvent.click(screen.getByTestId('session-tree-todo-s-2'))

    await waitFor(() => expect(focusedGroup(stored())!.activeTab).toBe(OVER_B))
    expect(groupOfSession(stored(), 'a')!.activeTab).toBe(OVER_A)
    expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
  })
})
