import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { installVirtualLayout, type VirtualLayout } from '@/test/virtual-layout'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import {
  apiMocks,
  emit,
  gateway,
  pane,
  renderRoute,
  sessionIds,
  sessionTransfer,
} from './multi-pane-page-harness'
function openChatBeside() {
  const desktopNewChat = screen.getAllByRole('button', { name: 'New chat' })[0]
  const actionsPill = desktopNewChat.parentElement!
  fireEvent.click(within(actionsPill).getByRole('button', { name: 'More options' }))
  fireEvent.click(within(actionsPill).getByRole('button', { name: 'Open beside' }))
}
function seedWorkingSet(ids = sessionIds) {
  localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ids, focusedId: ids[0], focusHistory: ids }))
}

describe('the routed multi-pane surface', () => {
  const desktopWidth = 1440
  let pickerLayout: VirtualLayout | null = null

  beforeEach(() => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd')
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: desktopWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 900 })
    localStorage.clear()
    gateway.listeners.clear()
    apiMocks.sendMessage.mockClear()
    apiMocks.createSession.mockClear()
    seedWorkingSet()
  })
  afterEach(() => {
    pickerLayout?.release()
    pickerLayout = null
  })
  const installPickerLayout = () => {
    pickerLayout = installVirtualLayout(44, 360, {
      scroller: '[data-testid="session-picker-scroll"]',
      row: '[data-session-picker-row]',
      rowId: 'data-session-picker-row',
    })
  }

  it('keeps four live transcripts isolated and preserves a streaming pane while a sibling closes', async () => {
    renderRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    await waitFor(() => sessionIds.forEach((id) => expect(pane(id).textContent).toContain(`transcript-${id}`)))

    fireEvent.click(pane('c'))
    await waitFor(() => expect(pane('c').getAttribute('data-chat-pane-active')).toBe('true'))
    await waitFor(() => expect(screen.getAllByText('Title c').length).toBeGreaterThan(0))

    const untouched = new Map(['a', 'b', 'd'].map((id) => [id, pane(id).textContent]))
    const textarea = pane('c').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'only-c-grows' } })
    textarea.focus()
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.sendMessage).toHaveBeenCalledWith('c', expect.objectContaining({ message: 'only-c-grows' })))
    expect(document.activeElement).toBe(textarea)
    for (const [id, text] of untouched) expect(pane(id).textContent).toBe(text)
    expect(pane('c').textContent?.match(/only-c-grows/g)).toHaveLength(1)

    const foregroundBeforeBackground = pane('c').textContent
    emit('session:delta', { sessionId: 'b', type: 'text', content: 'background-b' })
    await waitFor(() => expect(pane('b').textContent).toContain('background-b'))
    expect(pane('c').textContent).toBe(foregroundBeforeBackground)
    expect(pane('a').textContent).toBe(untouched.get('a'))
    expect(pane('d').textContent).toBe(untouched.get('d'))

    emit('session:delta', { sessionId: 'c', type: 'text', content: 'stream-c' })
    await waitFor(() => expect(pane('c').textContent).toContain('stream-c'))
    const streamingPane = screen.getByTestId('pane-c')
    const streamingChatPane = pane('c')
    const streamingText = pane('c').textContent

    fireEvent.click(screen.getByRole('button', { name: 'Close Title b' }))
    await waitFor(() => expect(document.querySelector('[data-chat-pane-session="b"]')).toBeNull())
    expect(screen.getByTestId('pane-c')).toBe(streamingPane)
    expect(pane('c')).toBe(streamingChatPane)
    expect(pane('c').textContent).toBe(streamingText)
    emit('session:delta', { sessionId: 'c', type: 'text', content: '-still-streaming' })
    await waitFor(() => expect(pane('c').textContent?.match(/still-streaming/g)).toHaveLength(1))
    expect(pane('c')).toBe(streamingChatPane)
    expect(pane('a').textContent).toContain('transcript-a')
    expect(pane('d').textContent).toContain('transcript-d')
  })

  it('paints the same live pane and persists the same set from drop and picker', async () => {
    const initial = JSON.stringify({
      version: 1,
      sessionIds: ['a', 'b'],
      focusedId: 'a',
      focusHistory: ['a', 'b'],
    })
    localStorage.setItem(WORKING_SET_STORAGE_KEY, initial)
    const dropped = renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(2))
    const surface = document.querySelector<HTMLElement>('[data-chat-grid-drop-surface]')!
    fireEvent.drop(surface, { dataTransfer: sessionTransfer('c') })
    await waitFor(() => expect(pane('c').textContent).toContain('transcript-c'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(['a', 'b', 'c']))
    const dropState = localStorage.getItem(WORKING_SET_STORAGE_KEY)
    dropped.unmount()

    gateway.listeners.clear()
    localStorage.setItem(WORKING_SET_STORAGE_KEY, initial)
    installPickerLayout()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(2))
    const desktopNewChat = screen.getAllByRole('button', { name: 'New chat' })[0]
    const actionsPill = desktopNewChat.parentElement!
    expect(within(actionsPill).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['New chat', 'More options'])
    openChatBeside()
    fireEvent.click(await screen.findByRole('option', { name: /Title c/ }))
    await waitFor(() => expect(pane('c').textContent).toContain('transcript-c'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(['a', 'b', 'c']))
    expect(localStorage.getItem(WORKING_SET_STORAGE_KEY)).toBe(dropState)
  })

  it('adds a second pane from the header action while keeping the original pane mounted', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    installPickerLayout()
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    const originalPane = pane('a')

    openChatBeside()
    fireEvent.click(await screen.findByRole('option', { name: /Title b/ }))

    await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))
    expect(pane('a')).toBe(originalPane)
  })

  it('hosts the picker in an empty pane, then swaps it for a picked or freshly composed chat', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    installPickerLayout()
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))
    openChatBeside()
    const picker = await screen.findByRole('combobox', { name: 'Search chats' })
    const pickerPane = picker.closest('[data-chat-grid-pane]')
    expect(pickerPane?.querySelector('[data-chat-pane-session="new"]')).toBeTruthy()
    expect(Array.from(document.querySelectorAll('[data-chat-grid-pane]')).at(-1)).toBe(pickerPane)
    fireEvent.click(await screen.findByRole('option', { name: /Title b/ }))
    await waitFor(() => expect(pane('b').textContent).toContain('transcript-b'))
    await waitFor(() => expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(['a', 'b']))
    expect(Array.from(document.querySelectorAll('[data-chat-grid-pane]')).at(-1)?.querySelector('[data-chat-pane-session="b"]')).toBeTruthy()

    openChatBeside()
    const freshPicker = await screen.findByRole('combobox', { name: 'Search chats' })
    const freshPane = freshPicker.closest<HTMLElement>('[data-chat-pane-session="new"]')!
    const textarea = freshPane.querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'fresh beside' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'fresh beside' })))
    await waitFor(() => expect(pane('e').textContent).toContain('transcript-e'))
    expect(freshPicker.isConnected).toBe(false)
  })

  it('replaces a lone chat with the composer instead of splitting New chat', async () => {
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: ['a'],
      focusedId: 'a',
      focusHistory: ['a'],
    }))
    renderRoute()
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])

    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(screen.getByTestId('chat-grid').getAttribute('data-single-pane')).toBe('true')
    expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(1)
  })

  it('opens New chat as a tab of the focused pane, folding nothing, and commits it to its chat in place', async () => {
    sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c', 'd', 'f', 'g')
    seedWorkingSet()
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(6))
    const tabIds = (node: Element) => Array.from(node.closest('[data-chat-grid-pane]')!.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute('data-pane-tab-kind') ?? tab.getAttribute('data-pane-tab-id'))

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])

    // The composer is a tab beside the focused pane's chat, which it covers: no pane is added or folded.
    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(6)
    expect(document.querySelector('[data-chat-pane-session="a"]')).toBeNull()
    expect(pane('b')).toBeDefined()
    expect(tabIds(pane('new'))).toEqual(['a', 'new-chat'])
    // The new chat is no session: the URL and the persisted working set never see it.
    expect(screen.getByTestId('route-location').textContent).toContain('session=a')
    expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(sessionIds)

    const textarea = pane('new').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'commit-composer' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })

    // Its first send makes it that chat's tab, in the same slot, and the route moves to it.
    await waitFor(() => expect(apiMocks.createSession).toHaveBeenCalled())
    await waitFor(() => expect(pane('e').textContent).toContain('commit-composer'))
    expect(document.querySelectorAll('[data-chat-grid-pane]')).toHaveLength(6)
    expect(tabIds(pane('e'))).toEqual(['a', 'e'])
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toContain('session=e'))
    expect(pane('b')).toBeDefined()
  })

  it('sends from a New chat tab as a new history entry: back returns to the chat it opened over', async () => {
    seedWorkingSet(['a', 'b'])
    renderRoute(['/?session=b', '/?session=a'])
    await waitFor(() => expect(pane('a').textContent).toContain('transcript-a'))

    fireEvent.click(screen.getAllByRole('button', { name: 'New chat' })[0])
    await waitFor(() => expect(pane('new')).toBeDefined())
    const textarea = pane('new').querySelector<HTMLTextAreaElement>('[data-chat-textarea]')!
    fireEvent.change(textarea, { target: { value: 'from the tab' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=e'))

    fireEvent.click(screen.getByRole('button', { name: 'Test browser back' }))
    await waitFor(() => expect(screen.getByTestId('route-location').textContent).toBe('/?session=a'))
  })

  it('opens an ?employee= deep link as a New chat tab once the stored layout has loaded', async () => {
    seedWorkingSet(['a', 'b'])
    renderRoute('/?employee=writer')

    await waitFor(() => expect(document.querySelector('[data-pane-tab-kind="new-chat"]')).not.toBeNull())
    const keys = Array.from(document.querySelectorAll('[data-chat-grid-pane]')).map((node) => node.getAttribute('data-chat-grid-pane'))
    expect(keys.some((key) => key?.startsWith('__new__'))).toBe(false)
    expect(keys.some((key) => key?.startsWith('new:') && key.includes('employee=writer'))).toBe(true)
  })

  it('renders exactly one composer pane when the working set is empty', async () => {
    sessionIds.length = 0
    localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessionIds: [],
      focusedId: null,
      focusHistory: [],
    }))
    renderRoute('/')

    fireEvent.click(screen.getAllByRole('button', { name: 'Start empty chat' })[0])

    await waitFor(() => expect(pane('new')).toBeDefined())
    expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1)
  })

  it('reacts to desktop-to-phone resize without discarding persisted members or the focused pane', async () => {
    renderRoute()
    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(4))
    fireEvent.click(pane('c'))
    await waitFor(() => expect(pane('c').getAttribute('data-chat-pane-active')).toBe('true'))

    act(() => {
      window.innerWidth = 1000
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() => expect(document.querySelectorAll('[data-chat-pane-session]')).toHaveLength(1))
    expect(pane('c')).toBeDefined()
    expect(JSON.parse(localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? '{}').sessionIds).toEqual(sessionIds)
  })
})
