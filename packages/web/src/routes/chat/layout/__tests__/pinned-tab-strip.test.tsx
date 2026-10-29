import "@/test/preload-menus"
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PaneTabStrip, type PaneTabItem, type PaneTabStripProps } from '../pane-tab-strip'

const TABS: PaneTabItem[] = [
  { id: 'p1', title: 'Pinned one', employee: 'op', pinned: true, closable: false },
  { id: 'p2', title: 'Pinned two', kind: 'todos', pinned: true, closable: false },
  { id: 'a', title: 'Alpha', employee: 'op' },
  { id: 'b', title: 'Beta', employee: 'op' },
]

function setup(props: Partial<PaneTabStripProps> = {}) {
  const handlers = {
    onActivate: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onMoveIn: vi.fn(), onDropSession: vi.fn(), onKeep: vi.fn(), onPin: vi.fn(), onUnpin: vi.fn(),
  }
  const utils = render(<PaneTabStrip groupId="g1" tabs={TABS} activeId="a" {...handlers} {...props} />)
  const tab = (id: string) => utils.container.querySelector<HTMLElement>(`[data-pane-tab-id="${id}"]`)!
  return { ...utils, ...handlers, tab }
}

describe('a strip with pinned tabs', () => {
  it('marks the pinned tabs compact and puts one divider after the last of them', () => {
    const { tab } = setup()
    expect(tab('p1').dataset.pinned).toBe('true')
    expect(tab('p1').className).toContain('max-w-[120px]')
    expect(tab('p1').className).not.toContain('min-w-[96px]')
    expect(tab('a').dataset.pinned).toBeUndefined()
    expect(tab('a').className).toContain('min-w-[96px]')
    expect([...document.querySelectorAll('[data-pinned-end]')].map((node) => (node as HTMLElement).dataset.paneTabId)).toEqual(['p2'])
  })

  it('draws no divider when every tab is pinned', () => {
    setup({ tabs: TABS.slice(0, 2) })
    expect(document.querySelector('[data-pinned-end]')).toBeNull()
  })

  it('has no close button on a pinned tab, and a pin glyph that unpins it', () => {
    const { tab, onUnpin, onClose } = setup()
    expect(tab('p1').querySelector('[aria-label^="Close tab"]')).toBeNull()
    expect(tab('a').querySelector('[aria-label="Close tab Alpha"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unpin tab Pinned one' }))
    expect(onUnpin).toHaveBeenCalledWith('p1')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers a pin button beside the close button of an unpinned tab only', () => {
    const { tab, onPin, onActivate } = setup()
    expect(tab('p1').querySelector('[aria-label^="Pin tab"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pin tab Beta' }))
    expect(onPin).toHaveBeenCalledWith('b')
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('does nothing for Delete, Backspace or a middle-click on a pinned tab', () => {
    const { tab, onClose } = setup()
    fireEvent.keyDown(tab('p1'), { key: 'Delete' })
    fireEvent.keyDown(tab('p1'), { key: 'Backspace' })
    fireEvent.mouseDown(tab('p1'), { button: 1 })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(tab('a'), { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('a')
  })

  it('opens a menu on right-click: Pin tab and Close tab for an unpinned tab', async () => {
    const { tab, onPin, onClose } = setup()
    fireEvent.contextMenu(tab('a'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin tab' }))
    expect(onPin).toHaveBeenCalledWith('a')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers Unpin tab and no Close tab for a pinned tab', async () => {
    const { tab, onUnpin } = setup()
    fireEvent.contextMenu(tab('p1'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Unpin tab'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpin tab' }))
    expect(onUnpin).toHaveBeenCalledWith('p1')
  })

  it('closes a tab from its menu, and leaves Close tab out for a tab that cannot be closed', async () => {
    const { tab, onClose } = setup({ tabs: [...TABS.slice(0, 3), { id: 'b', title: 'Beta', closable: false }] })
    fireEvent.contextMenu(tab('a'), { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledWith('a')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    fireEvent.contextMenu(tab('b'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab'])
  })

  it.each([['Shift+F10', '{Shift>}{F10}{/Shift}'], ['the Menu key', '{ContextMenu}']])('opens the menu from %s on the focused tab', async (_name, keys) => {
    const { tab } = setup()
    tab('a').focus()
    await userEvent.keyboard(keys)
    expect(await screen.findByRole('menuitem', { name: 'Pin tab' })).toBeTruthy()
  })

  it('shows the tooltip a tab carries, else its title', () => {
    const { tab } = setup({ tabs: [{ id: 'a', title: 'Alpha', tooltip: 'Alpha — Operator' }, { id: 'b', title: 'Beta' }] })
    expect(tab('a').title).toBe('Alpha — Operator')
    expect(tab('b').title).toBe('Beta')
  })

  it('offers no pin controls or menu without the pin callbacks', () => {
    const { tab } = setup({ onPin: undefined, onUnpin: undefined })
    expect(tab('a').querySelector('[data-pane-tab-pin]')).toBeNull()
    fireEvent.contextMenu(tab('a'), { clientX: 10, clientY: 10 })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
