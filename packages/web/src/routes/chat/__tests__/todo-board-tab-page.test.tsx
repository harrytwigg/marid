import "@/test/preload-menus"
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { apiMocks, chatTabsMock, gateway, renderRoute, seededChatTabs, sessionIds } from './multi-pane-page-harness'
import { chatPanes, composerPanes, seedLayout, settled, setViewport, storedGroups } from './todos-tab-page-support'

// The sub-board has its own suites; here it is a stand-in that says it is on screen.
vi.mock('@/routes/todos/board/sub-board-tab-view', () => ({ default: ({ todoId }: { todoId: string }) => <div data-testid={`sub-board-stub-${todoId}`} /> }))

const boardPanes = () => document.querySelectorAll('[data-doc-pane-kind="todo-board"]')
const route = () => screen.getByTestId('route-location').textContent

/* A sub-board pinned from a link (`/?open=todo-board:<id>`), landing on a layout that already holds a chat, which is the
 * normal case: the tab has to be in front the moment the link is followed, with no composer of the route's drawn over it. */
describe('the sub-board tab opened by a link, on the chat page', () => {
  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.createSession.mockClear()
    chatTabsMock.tabs = seededChatTabs()
    chatTabsMock.closeAllTabs.mockClear()
    setViewport(1440, 900)
  })

  it('shows over the chat of a chat-only layout, and the route names that chat (no blank new chat)', async () => {
    seedLayout([{ tabs: ['a'] }])
    renderRoute('/?open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await waitFor(() => expect(route()).toBe('/?session=a'))
    await settled()
    expect(storedGroups().map((group) => group.tabs)).toEqual([['todo-board:TSK-1', 'a']])
    expect(composerPanes()).toHaveLength(0)
    expect(screen.getByTestId('sub-board-stub-TSK-1')).toBeTruthy()
  })

  it('shows in the focused pane of a layout with the Todos tab, beside the chat, with no composer', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['todos:'] }], { focused: 1 })
    renderRoute('/?open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await waitFor(() => expect(route()).toBe('/?session=a'))
    await settled()
    expect(storedGroups().map((group) => group.tabs)).toEqual([['a'], ['todo-board:TSK-1', 'todos:']])
    expect(chatPanes()).toEqual(['a'])
    expect(composerPanes()).toHaveLength(0)
  })

  it('shows in a pane of its own beside a chat, when the focused pane is a lone board', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['todo-board:TSK-9'] }], { focused: 1 })
    renderRoute('/?open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await waitFor(() => expect(route()).toBe('/?session=a'))
    await settled()
    expect(composerPanes()).toHaveLength(0)
  })

  it('shows on a layout with no chats at all, with no composer and no chat opened behind it', async () => {
    renderRoute('/?open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await waitFor(() => expect(route()).toBe('/'))
    await settled()
    expect(boardPanes()).toHaveLength(1)
    expect(chatPanes()).toEqual([])
    expect(composerPanes()).toHaveLength(0)
    expect(storedGroups().map((group) => group.tabs)).toEqual([['todo-board:TSK-1']])
  })

  it('shows on a layout of standalone tabs alone (the Todos tab), with no composer', async () => {
    seedLayout([{ tabs: ['todos:'] }])
    renderRoute('/?open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await settled()
    expect(chatPanes()).toEqual([])
    expect(composerPanes()).toHaveLength(0)
  })

  it('keeps the chat the address already names', async () => {
    seedLayout([{ tabs: ['a'] }, { tabs: ['b'] }], { focused: 1 })
    renderRoute('/?session=a&open=todo-board:TSK-1')

    expect(await screen.findByTestId('sub-board-stub-TSK-1')).toBeTruthy()
    await settled()
    expect(composerPanes()).toHaveLength(0)
    expect(route()).toBe('/?session=a')
  })

  it('drops a link that names no valid Todo from the address, as a valid one is dropped, and opens nothing', async () => {
    seedLayout([{ tabs: ['a'] }])
    renderRoute('/?open=todo-board:nope&view=x')

    await waitFor(() => expect(route()).not.toContain('open='))
    await settled()
    expect(boardPanes()).toHaveLength(0)
    expect(storedGroups().flatMap((group) => group.tabs)).toEqual(['a'])
  })
})
