import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { CompanyActivityCard } from '../company-activity-card'
import type { ChatBlock } from '@/lib/blocks'
import { TodoOpenContext, type OpenTodo } from '@/components/chat/file-open-context'
import { FileLinkSessionContext } from '@/components/chat/file-link-session-context'

function todoBlock(): ChatBlock {
  return {
    id: 'todo:JIN-7',
    type: 'todo-activity',
    version: 2,
    status: 'waiting',
    title: 'Prepare release',
    summary: 'In review',
    payload: { todoId: 'JIN-7', action: 'transitioned', status: 'in_review', updatedAt: '2026-07-12T01:00:00.000Z' },
  }
}

describe('CompanyActivityCard Open in the chat layout', () => {
  it('opens the Todo as a tab beside its chat where the chat layout takes one, else its page', async () => {
    const user = userEvent.setup()
    const tabbed = vi.fn<OpenTodo>(() => true)
    const router = createMemoryRouter(
      [{ path: '*', element: (
        <TodoOpenContext.Provider value={tabbed}>
          <FileLinkSessionContext.Provider value="chat-a"><CompanyActivityCard block={todoBlock()} /></FileLinkSessionContext.Provider>
        </TodoOpenContext.Provider>
      ) }],
      { initialEntries: ['/'] },
    )
    const view = render(<RouterProvider router={router} />)
    await user.click(screen.getByRole('button', { name: 'Open Prepare release todo' }))
    expect(tabbed).toHaveBeenCalledWith('JIN-7', 'chat-a')
    expect(router.state.location.pathname).toBe('/')
    view.unmount()

    const refused = vi.fn<OpenTodo>(() => false)
    const fallback = createMemoryRouter(
      [{ path: '*', element: <TodoOpenContext.Provider value={refused}><CompanyActivityCard block={todoBlock()} /></TodoOpenContext.Provider> }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={fallback} />)
    await user.click(screen.getByRole('button', { name: 'Open Prepare release todo' }))
    expect(fallback.state.location.pathname).toBe('/todos/JIN-7')
  })
})
