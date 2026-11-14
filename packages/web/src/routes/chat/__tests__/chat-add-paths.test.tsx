import { useCallback, useState } from 'react'
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatGridDropOverlay, useChatSessionDrop } from '../chat-grid-drop'
import { CHAT_SESSION_DND_MIME } from '../chat-session-dnd'
import { placementForPointer } from '../grid-placement'
import { createWorkingSet, insertWorkingSetSession, type ChatWorkingSet } from '../working-set'

function transfer(type: string, value: string): DataTransfer {
  return {
    types: [type],
    files: [] as unknown as FileList,
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: vi.fn(),
    getData: vi.fn((requested: string) => requested === type ? value : ''),
  } as unknown as DataTransfer
}

function fireDragAt(
  target: HTMLElement,
  kind: 'dragEnter' | 'dragLeave' | 'dragOver' | 'drop',
  point: { x: number; y: number },
  dataTransfer: DataTransfer,
): void {
  const event = createEvent[kind](target, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: point.x },
    clientY: { value: point.y },
    dataTransfer: { value: dataTransfer },
  })
  fireEvent(target, event)
}

function AddHarness({ initial, onAction }: {
  initial: ChatWorkingSet
  onAction?: (sessionId: string) => void
}) {
  const [state, setState] = useState(initial)
  const insert = useCallback((sessionId: string, index: number) => {
    onAction?.(sessionId)
    setState((current) => insertWorkingSetSession(current, sessionId, index, 4))
  }, [onAction])
  const drop = useChatSessionDrop(insert, {
    workingSet: state,
    cap: 4,
    primaryPaneKey: 'a',
    committedSessionId: 'a',
    pickerPaneKey: null,
    viewport: { width: 1440, height: 900 },
  })
  return (
    <div data-testid="drop-surface" {...drop.handlers}>
      <div data-testid="chat-grid">
        {state.sessionIds.map((id) => (
          <div key={id} data-chat-grid-pane={id} data-testid={`transcript-${id}`}>
            {id === 'a' && <><span data-message-id="a-1">A one</span><span data-message-id="a-2">A two</span></>}
          </div>
        ))}
      </div>
      <div data-chat-composer data-testid="composer">Composer</div>
      <output data-testid="working-set">{JSON.stringify(state)}</output>
      <ChatGridDropOverlay placement={drop.placement} />
    </div>
  )
}

async function stateAfterDrop(): Promise<ChatWorkingSet> {
  const view = render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
  fireEvent.drop(screen.getByTestId('drop-surface'), { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
  await waitFor(() => expect(screen.getByTestId('working-set').textContent).toContain('"c"'))
  const state = JSON.parse(screen.getByTestId('working-set').textContent ?? '') as ChatWorkingSet
  view.unmount()
  return state
}

describe('chat grid add paths', () => {
  it('routes a drop through the working-set add contract', async () => {
    const expected = {
      sessionIds: ['a', 'b', 'c'],
      focusedId: 'c',
      focusHistory: ['b', 'a', 'c'],
    }
    expect(await stateAfterDrop()).toEqual(expected)
  })

  it('focuses a duplicate drop without duplicating or reordering it', async () => {
    const action = vi.fn()
    render(<AddHarness initial={createWorkingSet(['a', 'b', 'c'], 'a')} onAction={action} />)
    fireEvent.drop(screen.getByTestId('drop-surface'), { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    await waitFor(() => expect(screen.getByTestId('working-set').textContent).toContain('"focusedId":"c"'))
    expect(JSON.parse(screen.getByTestId('working-set').textContent ?? '')).toEqual({
      sessionIds: ['a', 'b', 'c'],
      focusedId: 'c',
      focusHistory: ['b', 'a', 'c'],
    })
    expect(action).toHaveBeenCalledOnce()
  })

  it('rejects composer and foreign drops without moving or reordering transcript rows', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'drop-surface' || this.dataset.testid === 'chat-grid') {
        return new DOMRect(0, 0, 200, 100)
      }
      return this.dataset.chatGridPane === 'a'
        ? new DOMRect(0, 0, 100, 100)
        : new DOMRect(100, 0, 100, 100)
    })
    const action = vi.fn()
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} onAction={action} />)
    const composer = screen.getByTestId('composer')
    const transcript = screen.getByTestId('transcript-a')
    const rows = [...transcript.children]
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'c')
    fireDragAt(transcript, 'dragOver', { x: 10, y: 50 }, dataTransfer)
    expect(screen.queryByTestId('chat-grid-drop-zone')).not.toBeNull()
    fireDragAt(composer, 'dragEnter', { x: 100, y: 90 }, dataTransfer)
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
    const blockedOver = createEvent.dragOver(composer, { bubbles: true, cancelable: true })
    Object.defineProperty(blockedOver, 'dataTransfer', { value: dataTransfer })
    fireEvent(composer, blockedOver)
    expect(blockedOver.defaultPrevented).toBe(false)
    fireEvent.drop(composer, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    fireEvent.drop(transcript, { dataTransfer: transfer('application/x-hundredfold-chat-message', 'message-a-1') })
    expect(action).not.toHaveBeenCalled()
    expect([...transcript.children]).toEqual(rows)
    expect(screen.getByTestId('working-set').textContent).toBe(JSON.stringify(createWorkingSet(['a', 'b'], 'a')))
  })

  it('shows a pointer-transparent drop zone only for an eligible transcript drop', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 200, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    fireDragAt(surface, 'dragOver', { x: 10, y: 50 }, transfer(CHAT_SESSION_DND_MIME, 'c'))
    const overlay = screen.getByTestId('chat-grid-drop-zone')
    expect(overlay.className).toContain('pointer-events-none')
    expect(overlay.className).not.toContain('transition')
    fireEvent.dragLeave(surface, { dataTransfer: transfer(CHAT_SESSION_DND_MIME, 'c') })
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
  })

  it('clears the preview after balanced internal transitions and a final grid leave', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'drop-surface' || this.dataset.testid === 'chat-grid') {
        return new DOMRect(0, 0, 200, 100)
      }
      return this.dataset.chatGridPane === 'a'
        ? new DOMRect(0, 0, 100, 100)
        : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const paneA = screen.getByTestId('transcript-a')
    const paneB = screen.getByTestId('transcript-b')
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'c')

    fireDragAt(surface, 'dragEnter', { x: 10, y: 50 }, dataTransfer)
    fireDragAt(surface, 'dragOver', { x: 10, y: 50 }, dataTransfer)
    fireDragAt(surface, 'dragLeave', { x: 10, y: 50 }, dataTransfer)
    fireDragAt(paneA, 'dragEnter', { x: 10, y: 50 }, dataTransfer)
    fireDragAt(paneA, 'dragOver', { x: 10, y: 50 }, dataTransfer)
    fireDragAt(paneA, 'dragLeave', { x: 110, y: 50 }, dataTransfer)
    fireDragAt(paneB, 'dragEnter', { x: 110, y: 50 }, dataTransfer)
    fireDragAt(paneB, 'dragOver', { x: 110, y: 50 }, dataTransfer)
    expect(screen.queryByTestId('chat-grid-drop-zone')).not.toBeNull()

    fireDragAt(paneB, 'dragLeave', { x: -40, y: 50 }, dataTransfer)

    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
  })

  it('clears an active preview on escape and an aborted window dragend', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 200, 100)
      return this.dataset.chatGridPane === 'a'
        ? new DOMRect(0, 0, 100, 100)
        : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'c')

    fireDragAt(surface, 'dragOver', { x: 10, y: 50 }, dataTransfer)
    expect(screen.queryByTestId('chat-grid-drop-zone')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()

    fireDragAt(surface, 'dragOver', { x: 110, y: 50 }, dataTransfer)
    expect(screen.queryByTestId('chat-grid-drop-zone')).not.toBeNull()
    fireEvent.dragEnd(window)
    expect(screen.queryByTestId('chat-grid-drop-zone')).toBeNull()
  })

  it('renders the placement model index and region for every pane slice', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 250, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const paneRects = [new DOMRect(0, 0, 100, 100), new DOMRect(100, 0, 100, 100)]
    const gridRect = new DOMRect(0, 0, 250, 100)
    const points = [
      { x: 10, y: 50 },
      { x: 90, y: 50 },
      { x: 50, y: 10 },
      { x: 50, y: 90 },
      { x: 225, y: 50 },
    ]

    for (const point of points) {
      fireDragAt(surface, 'dragOver', point, transfer(CHAT_SESSION_DND_MIME, 'c'))
      const expected = placementForPointer(point, paneRects, gridRect)!
      const preview = screen.getByTestId('chat-grid-drop-zone')
      expect(preview.dataset.dropRegion).toBe(expected.region)
      expect(preview.dataset.dropIndex).toBe(String(expected.targetIndex))
    }
  })

  it('drops at the exact insertion index shown by the live preview', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 200, 100)
      const id = this.dataset.chatGridPane
      return id === 'a' ? new DOMRect(0, 0, 100, 100) : new DOMRect(100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b'], 'a')} />)
    const surface = screen.getByTestId('drop-surface')
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'c')
    fireDragAt(surface, 'dragOver', { x: 110, y: 50 }, dataTransfer)
    expect(screen.getByTestId('chat-grid-drop-zone').dataset.dropIndex).toBe('1')

    fireDragAt(surface, 'drop', { x: 110, y: 50 }, dataTransfer)

    await waitFor(() => expect(JSON.parse(screen.getByTestId('working-set').textContent ?? '').sessionIds).toEqual(['a', 'c', 'b']))
  })

  it('keeps the previewed index when a full grid evicts a pane', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'chat-grid') return new DOMRect(0, 0, 400, 100)
      const index = ['a', 'b', 'c', 'd'].indexOf(this.dataset.chatGridPane ?? '')
      return new DOMRect(index * 100, 0, 100, 100)
    })
    render(<AddHarness initial={createWorkingSet(['a', 'b', 'c', 'd'], 'd')} />)
    const surface = screen.getByTestId('drop-surface')
    const dataTransfer = transfer(CHAT_SESSION_DND_MIME, 'new')
    fireDragAt(surface, 'dragOver', { x: 90, y: 50 }, dataTransfer)
    expect(screen.getByTestId('chat-grid-drop-zone').dataset.dropIndex).toBe('1')

    fireDragAt(surface, 'drop', { x: 90, y: 50 }, dataTransfer)

    await waitFor(() => expect(JSON.parse(screen.getByTestId('working-set').textContent ?? '').sessionIds).toEqual(['a', 'new', 'c', 'd']))
  })
})
