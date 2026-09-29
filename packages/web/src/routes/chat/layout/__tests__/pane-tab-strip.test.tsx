import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { CHAT_SESSION_DND_MIME, clearChatSessionDrag } from '../../chat-session-dnd'
import { PANE_TAB_DND_MIME, clearPaneTabDrag, insertionIndexForPointer, reorderTarget } from '../pane-tab-dnd'
import { PaneTabStrip, tabKeyAction, type PaneTabItem, type PaneTabStripProps } from '../pane-tab-strip'

const TABS: PaneTabItem[] = [
  { id: 'a', title: '#1 - Alpha', employee: 'op' },
  { id: 'b', title: 'Beta', employee: 'op', preview: true, status: 'running' },
  { id: 'c', title: 'Gamma', employee: 'op' },
]

function fakeDataTransfer(data: Record<string, string> = {}) {
  const store = { ...data }
  return {
    get types() { return Object.keys(store) },
    setData: (type: string, value: string) => { store[type] = value },
    getData: (type: string) => store[type] ?? '',
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
  }
}

/** jsdom has no DragEvent, so fireEvent drops clientX; build the event by hand. */
function dragAt(type: 'dragover' | 'drop', target: Element, dataTransfer: unknown, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { dataTransfer, clientX })
  act(() => { target.dispatchEvent(event) })
  return event
}

function setup(props: Partial<PaneTabStripProps> = {}) {
  const handlers = {
    onActivate: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onMoveIn: vi.fn(), onDropSession: vi.fn(), onPin: vi.fn(),
  }
  const utils = render(<PaneTabStrip groupId="g1" tabs={TABS} activeId="a" {...handlers} {...props} />)
  const tab = (id: string) => utils.container.querySelector<HTMLElement>(`[data-pane-tab-id="${id}"]`)!
  // jsdom has no layout: give each tab a 100px slot so pointer x maps to a slot.
  TABS.forEach((item, i) => {
    const node = utils.container.querySelector<HTMLElement>(`[data-pane-tab-id="${item.id}"]`)
    if (node) node.getBoundingClientRect = () => ({ left: i * 100, width: 100, right: i * 100 + 100, top: 0, bottom: 30, height: 30, x: i * 100, y: 0, toJSON: () => ({}) })
  })
  return { ...utils, ...handlers, tab, strip: screen.getByTestId('pane-tab-strip') }
}

afterEach(() => { clearPaneTabDrag(); clearChatSessionDrag() })

describe('pure helpers', () => {
  it('maps a pointer to an insertion slot by tab midpoints', () => {
    const rects = [0, 100, 200].map((left) => ({ left, width: 100 }))
    expect(insertionIndexForPointer(rects, 10)).toBe(0)
    expect(insertionIndexForPointer(rects, 60)).toBe(1)
    expect(insertionIndexForPointer(rects, 149)).toBe(1)
    expect(insertionIndexForPointer(rects, 151)).toBe(2)
    expect(insertionIndexForPointer(rects, 999)).toBe(3)
    expect(insertionIndexForPointer([], 5)).toBe(0)
  })

  it('accounts for the dragged tab leaving its own slot', () => {
    expect(reorderTarget(0, 3)).toBe(2)
    expect(reorderTarget(0, 1)).toBe(0)
    expect(reorderTarget(2, 0)).toBe(0)
    expect(reorderTarget(1, 1)).toBe(1)
  })

  it('translates keys into tab actions', () => {
    expect(tabKeyAction('ArrowRight', 2, 3, false)).toEqual({ kind: 'focus', index: 0 })
    expect(tabKeyAction('ArrowLeft', 0, 3, false)).toEqual({ kind: 'focus', index: 2 })
    expect(tabKeyAction('Home', 2, 3, false)).toEqual({ kind: 'focus', index: 0 })
    expect(tabKeyAction('End', 0, 3, false)).toEqual({ kind: 'focus', index: 2 })
    expect(tabKeyAction('ArrowRight', 0, 3, true)).toEqual({ kind: 'reorder', index: 1 })
    expect(tabKeyAction('ArrowLeft', 0, 3, true)).toBeNull()
    expect(tabKeyAction('Delete', 1, 3, false)).toEqual({ kind: 'close' })
    expect(tabKeyAction('x', 1, 3, false)).toBeNull()
    expect(tabKeyAction('ArrowRight', 0, 0, false)).toBeNull()
  })
})

describe('PaneTabStrip', () => {
  it('renders an ARIA tablist with the active tab selected and a roving tab stop', () => {
    const { tab } = setup({ activeId: 'b' })
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getAllByRole('tab').map((node) => node.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(tab('b').tabIndex).toBe(0)
    expect(tab('a').tabIndex).toBe(-1)
    // Labels stay at or above text-secondary (>= 4.5:1 in every theme); the tertiary and quaternary ink is not.
    expect(tab('a').className).toContain('text-[var(--text-secondary)]')
    expect(tab('a').className).not.toMatch(/tertiary|quaternary/)
    expect(within(tab('a')).getByText('#1').className).not.toMatch(/tertiary|quaternary/)
    expect(tab('b').querySelector('[data-pane-tab-title]')?.className).toContain('italic')
    expect(tab('a').querySelector('[data-pane-tab-title]')?.className).not.toContain('italic')
    expect(tab('b').querySelector('[data-pane-tab-status="running"]')).toBeTruthy()
  })

  it('activates on click, closes on × and middle-click, pins a preview on double-click', () => {
    const { tab, onActivate, onClose, onPin } = setup()
    fireEvent.click(tab('c'))
    expect(onActivate).toHaveBeenCalledWith('c')

    fireEvent.click(screen.getByLabelText('Close tab Gamma'))
    expect(onClose).toHaveBeenLastCalledWith('c')
    expect(onActivate).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(tab('a'), { button: 1 })
    expect(onClose).toHaveBeenLastCalledWith('a')
    fireEvent.mouseDown(tab('a'), { button: 0 })
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.doubleClick(tab('a'))
    expect(onPin).not.toHaveBeenCalled()
    fireEvent.doubleClick(tab('b'))
    expect(onPin).toHaveBeenCalledWith('b')
  })

  it('moves focus and activation with the arrow keys, wrapping at the ends', () => {
    const { tab, onActivate } = setup({ activeId: 'c' })
    fireEvent.keyDown(tab('c'), { key: 'ArrowRight' })
    expect(onActivate).toHaveBeenLastCalledWith('a')
    expect(document.activeElement).toBe(tab('a'))
    fireEvent.keyDown(tab('a'), { key: 'End' })
    expect(onActivate).toHaveBeenLastCalledWith('c')
  })

  it('closes the focused tab on Delete and reorders on Alt+Arrow', () => {
    const { tab, onClose, onReorder } = setup()
    fireEvent.keyDown(tab('b'), { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('b')
    fireEvent.keyDown(tab('b'), { key: 'ArrowRight', altKey: true })
    expect(onReorder).toHaveBeenCalledWith('b', 2)
    fireEvent.keyDown(tab('c'), { key: 'ArrowRight', altKey: true })
    expect(onReorder).toHaveBeenCalledTimes(1)
  })

  it('re-orders a tab dragged within its own strip', () => {
    const { tab, strip, onReorder, onMoveIn } = setup()
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(tab('a'), { dataTransfer })
    expect(dataTransfer.types).toContain(PANE_TAB_DND_MIME)
    dragAt('dragover', strip, dataTransfer, 260)
    expect(tab('c').getAttribute('data-drop-after')).toBe('true')
    dragAt('drop', strip, dataTransfer, 260)
    expect(onReorder).toHaveBeenCalledWith('a', 2)
    expect(onMoveIn).not.toHaveBeenCalled()
    expect(tab('c').hasAttribute('data-drop-after')).toBe(false)
  })

  it('does nothing when a tab is dropped back where it was', () => {
    const { tab, strip, onReorder } = setup()
    const dataTransfer = fakeDataTransfer()
    fireEvent.dragStart(tab('b'), { dataTransfer })
    dragAt('drop', strip, dataTransfer, 160)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('accepts a tab from another strip at the insertion slot', () => {
    const { strip, onMoveIn, onReorder } = setup()
    const dataTransfer = fakeDataTransfer({ [PANE_TAB_DND_MIME]: JSON.stringify({ groupId: 'g2', tabId: 'z' }) })
    dragAt('dragover', strip, dataTransfer, 120)
    dragAt('drop', strip, dataTransfer, 120)
    expect(onMoveIn).toHaveBeenCalledWith('g2', 'z', 1)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('adds a chat dragged from the sidebar as a tab, and ignores unrelated drags', () => {
    const { strip, onDropSession, onMoveIn } = setup()
    dragAt('drop', strip, fakeDataTransfer({ [CHAT_SESSION_DND_MIME]: 'sess-9' }), 5)
    expect(onDropSession).toHaveBeenCalledWith('sess-9', 0)

    const other = fakeDataTransfer({ 'text/plain': 'x' })
    const event = new Event('dragover', { bubbles: true, cancelable: true })
    Object.assign(event, { dataTransfer: other, clientX: 0 })
    strip.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(onMoveIn).not.toHaveBeenCalled()
  })

  it('stops drop events so a pane-level drop target does not also act on them', () => {
    const outer = vi.fn()
    const onDropSession = vi.fn()
    render(
      <div onDrop={outer}>
        <PaneTabStrip groupId="g1" tabs={TABS} activeId="a" onActivate={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} onMoveIn={vi.fn()} onDropSession={onDropSession} />
      </div>,
    )
    dragAt('drop', screen.getByTestId('pane-tab-strip'), fakeDataTransfer({ [CHAT_SESSION_DND_MIME]: 's' }), 0)
    expect(onDropSession).toHaveBeenCalledWith('s', expect.any(Number))
    expect(outer).not.toHaveBeenCalled()
  })

  it('keeps the keys it handles away from the window-level shortcuts', () => {
    // Delete and Backspace are also the app's delete-session keys, listening on window.
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      const { tab, onClose } = setup()
      fireEvent.keyDown(tab('b'), { key: 'Delete' })
      fireEvent.keyDown(tab('b'), { key: 'Backspace' })
      fireEvent.keyDown(tab('b'), { key: 'ArrowRight' })
      fireEvent.keyDown(tab('b'), { key: 'Home' })
      expect(onClose).toHaveBeenCalledTimes(2)
      expect(onWindowKey).not.toHaveBeenCalled()

      fireEvent.keyDown(tab('b'), { key: 'x' })
      expect(onWindowKey).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('marks the shown tab of the focused strip only', () => {
    const { container, rerender } = setup({ focused: true })
    expect(container.querySelectorAll('[data-pane-tab-marker]')).toHaveLength(1)
    expect(container.querySelector('[data-pane-tab-id="a"] [data-pane-tab-marker]')).toBeTruthy()
    rerender(<PaneTabStrip groupId="g1" tabs={TABS} activeId="a" focused={false} onActivate={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} onMoveIn={vi.fn()} />)
    expect(container.querySelectorAll('[data-pane-tab-marker]')).toHaveLength(0)
  })

  it('names a tab\'s close control apart from the pane\'s own close', () => {
    setup()
    expect(screen.getAllByRole('button').every((button) => /^Close tab /.test(button.getAttribute('aria-label') ?? ''))).toBe(true)
  })

  it('scrolls sideways on a vertical wheel when the strip overflows', () => {
    const { strip } = setup()
    fireEvent.wheel(strip, { deltaY: 40, deltaX: 0 })
    expect(strip.scrollLeft).toBe(40)
  })

  it('keeps the active tab in view', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const { rerender } = setup()
    rerender(<PaneTabStrip groupId="g1" tabs={TABS} activeId="c" onActivate={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} onMoveIn={vi.fn()} />)
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' })
  })
})
