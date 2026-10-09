import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { loadSplitLayout, persistSplitLayout } from '../layout/split-layout-storage'
import { createSplitLayout, focusedGroup, groupOfSession, openDocTab } from '../layout/split-layout'
import { todoTabId } from '../layout/tab-kind'
import { gateway, renderRoute, sessionIds } from './multi-pane-page-harness'

/** A Todo shown as a tab whose crumbs and sub-tasks name another Todo, already open over the other
 *  chat. The opener is the one the task page wires into both. */
vi.mock('@/components/chat/doc-view', async () => {
  const { CrumbBar } = await import('@/routes/todos/task-page/crumb-bar')
  const { SubTaskRow } = await import('@/routes/todos/task-page/subtask-row')
  const { useOpenTodoInPlace } = await import('@/routes/todos/task-page/task-frame')
  const { useNavigate } = await import('react-router-dom')
  const child = {
    id: 'PLA-2', title: 'Other', status: 'backlog', assignee: null, children: [],
  }
  function TodoTab() {
    const navigate = useNavigate()
    const openTodo = useOpenTodoInPlace(true, (id) => navigate(`/todos/${id}`))
    return (
      <div>
        <CrumbBar
          boardLabel="Board"
          onBack={() => {}}
          ancestors={[{ id: 'PLA-2', title: 'Other' }]}
          id="PLA-1"
          title="This"
          onOpenAncestor={openTodo}
          onCopyId={() => {}}
          mobile={false}
          pageSlots={false}
        />
        <SubTaskRow
          child={child as never}
          employees={[]}
          mobile={false}
          picking={null}
          onPick={() => {}}
          onOpenChild={openTodo}
          onChildStatus={() => {}}
          onChildAssign={() => {}}
        />
      </div>
    )
  }
  return {
    DocView: ({ doc }: { doc: { kind: string; todoId?: string } }) =>
      doc.kind === 'todo' && doc.todoId === 'PLA-1' ? <TodoTab /> : null,
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

describe("a Todo tab's crumbs and sub-tasks inside the chat layout", () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    seedLayout()
  })

  async function clickAndExpectFocusMoves(testId: string | (() => HTMLElement)) {
    renderRoute('/?session=a')
    await waitFor(() => expect(screen.getByTestId('task-crumb-PLA-2')).toBeTruthy())
    expect(focusedGroup(stored())!.activeTab).toBe(OVER_A)

    fireEvent.click(typeof testId === 'string' ? screen.getByTestId(testId) : testId())

    await waitFor(() => expect(focusedGroup(stored())!.activeTab).toBe(OVER_B))
    expect(groupOfSession(stored(), 'a')!.activeTab).toBe(OVER_A)
    expect(screen.getByTestId('route-location').textContent).toBe('/?session=a')
  }

  it('an ancestor crumb focuses the Todo\'s tab where it is open, and the pane it was clicked in does not take focus back', async () => {
    await clickAndExpectFocusMoves('task-crumb-PLA-2')
  })

  it('a sub-task row focuses the Todo\'s tab where it is open, and the pane it was clicked in does not take focus back', async () => {
    await clickAndExpectFocusMoves(() => screen.getByRole('button', { name: 'Other' }))
  })

  it('a sub-task\'s open button focuses the Todo\'s tab where it is open, and the pane it was clicked in does not take focus back', async () => {
    await clickAndExpectFocusMoves('subtask-open-PLA-2')
  })
})
