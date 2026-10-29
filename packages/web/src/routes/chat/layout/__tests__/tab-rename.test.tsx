import "@/test/preload-menus"
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { PaneTabsContext, type PaneTabActions, type PaneTabsBinding } from '@/components/chat/pane-tabs-context'
import { ChatPaneTitleBar } from '@/components/chat/chat-pane-title-bar'
import { paneTabHandlers, paneTabItems } from '../pane-tab-ops'
import { PaneTabStrip, type PaneTabItem, type PaneTabStripProps } from '../pane-tab-strip'
import { menuActions } from '../pane-tab-controls'
import { renderHook } from '@testing-library/react'
import { renamedTitle, TabRenameInput, useInlineRename } from '../tab-rename'

describe('renamedTitle', () => {
  it('trims the draft', () => expect(renamedTitle('Alpha', '  Beta  ')).toBe('Beta'))
  it('cancels on an empty or blank draft', () => {
    expect(renamedTitle('Alpha', '')).toBeNull()
    expect(renamedTitle('Alpha', '   ')).toBeNull()
  })
  it('cancels on an unchanged title, whatever the padding', () => {
    expect(renamedTitle('Alpha', 'Alpha')).toBeNull()
    expect(renamedTitle('Alpha', ' Alpha ')).toBeNull()
  })
})

describe('TabRenameInput', () => {
  function setup(value = 'Alpha') {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<TabRenameInput value={value} onCommit={onCommit} onCancel={onCancel} />)
    return { onCommit, onCancel, input: screen.getByLabelText('Rename tab') as HTMLInputElement }
  }

  it('starts on the current title, focused', () => {
    const { input } = setup()
    expect(input.value).toBe('Alpha')
    expect(document.activeElement).toBe(input)
  })

  it('commits the new title on Enter, once, with the blur that follows', () => {
    const { input, onCommit, onCancel } = setup()
    fireEvent.change(input, { target: { value: ' Beta ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Beta', false)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels on Escape, and does not commit on the blur that follows', () => {
    const { input, onCommit, onCancel } = setup()
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('cancels on Enter with an empty or unchanged title', () => {
    const empty = setup()
    fireEvent.change(empty.input, { target: { value: '' } })
    fireEvent.keyDown(empty.input, { key: 'Enter' })
    expect(empty.onCancel).toHaveBeenCalledTimes(1)
    expect(empty.onCommit).not.toHaveBeenCalled()
  })

  it('commits when focus leaves the field with a new title in it', () => {
    const { input, onCommit } = setup()
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('Beta', true)
  })

  it('says whether it ended by blur, so focus can be left where it went', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const { rerender } = render(<TabRenameInput value="Alpha" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.change(screen.getByLabelText('Rename tab'), { target: { value: 'Beta' } })
    fireEvent.blur(screen.getByLabelText('Rename tab'))
    expect(onCommit).toHaveBeenLastCalledWith('Beta', true)
    rerender(<TabRenameInput key="again" value="Alpha" onCommit={onCommit} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByLabelText('Rename tab'), { key: 'Escape' })
    expect(onCancel).toHaveBeenLastCalledWith(false)
  })

  it('keeps its keys from the tab around it, whose Delete closes and arrows move', () => {
    const outer = vi.fn()
    render(<div onKeyDown={outer}><TabRenameInput value="Alpha" onCommit={vi.fn()} onCancel={vi.fn()} /></div>)
    for (const key of ['Delete', 'Backspace', 'ArrowLeft', 'Enter']) fireEvent.keyDown(screen.getByLabelText('Rename tab'), { key })
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('useInlineRename', () => {
  it('hands focus back when a key ends the edit, and leaves it where it went when a blur does', () => {
    const onEnd = vi.fn()
    const save = vi.fn()
    const { result } = renderHook(() => useInlineRename(save, onEnd))
    act(() => result.current.start?.())
    expect(result.current.renaming).toBe(true)
    act(() => result.current.input?.onCommit('A', true))
    expect(save).toHaveBeenCalledWith('A')
    expect(onEnd).not.toHaveBeenCalled()
    act(() => result.current.start?.())
    act(() => result.current.input?.onCancel(true))
    expect(onEnd).not.toHaveBeenCalled()
    act(() => result.current.start?.())
    act(() => result.current.input?.onCancel(false))
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(result.current.renaming).toBe(false)
  })

  it('offers no way to start with nothing to save with', () => {
    expect(renderHook(() => useInlineRename(undefined)).result.current.start).toBeUndefined()
  })
})

describe('menuActions', () => {
  const close = vi.fn()
  const base = { onPin: vi.fn(), onUnpin: vi.fn(), onClose: close }
  it('offers rename on a chat tab when the strip can', () => {
    const rename = vi.fn()
    expect(menuActions({ id: 'a', title: 'A' }, { ...base, onRename: rename })?.rename).toBe(rename)
  })
  it('offers none on a document or new chat tab', () => {
    for (const kind of ['file', 'todo', 'todos', 'subagent', 'new-chat'] as const) {
      expect(menuActions({ id: 'x', title: 'X', kind }, { ...base, onRename: vi.fn() })?.rename).toBeUndefined()
    }
  })
  it('offers none when the strip cannot', () => {
    expect(menuActions({ id: 'a', title: 'A' }, base)?.rename).toBeUndefined()
  })
})

describe('chat tabs in the layout', () => {
  it('are the only strip items that are chats (no kind), which the rename follows', () => {
    const items = paneTabItems({ id: 'g', tabs: ['s1', 'new:1', 'todos:'], activeTab: 's1' } as never, () => undefined)
    expect(items.filter((item) => !item.kind).map((item) => item.id)).toEqual(['s1'])
  })

  it('reach the strip as its rename handler', () => {
    const rename = vi.fn()
    const ops = { layout: {} as never, place: vi.fn(), close: vi.fn(), select: vi.fn(), keep: vi.fn(), pin: vi.fn(), unpin: vi.fn(), rename }
    paneTabHandlers('g', ops).onRename?.('s1', 'Beta')
    expect(rename).toHaveBeenCalledWith('s1', 'Beta')
  })
})

describe('a strip tab', () => {
  const TABS: PaneTabItem[] = [
    { id: 'a', title: '#1 - Alpha', employee: 'op' },
    { id: 'b', title: 'Beta', employee: 'op' },
    { id: 'f', title: 'notes.md', kind: 'file', filePath: '/x/notes.md' },
  ]
  function setup(props: Partial<PaneTabStripProps> = {}) {
    const handlers = { onActivate: vi.fn(), onClose: vi.fn(), onReorder: vi.fn(), onMoveIn: vi.fn(), onPin: vi.fn(), onUnpin: vi.fn(), onRename: vi.fn() }
    const utils = render(<PaneTabStrip groupId="g1" tabs={TABS} activeId="a" {...handlers} {...props} />)
    const tab = (id: string) => utils.container.querySelector<HTMLElement>(`[data-pane-tab-id="${id}"]`)!
    return { ...handlers, tab }
  }

  it('offers Rename first in its right-click menu, and edits in place', async () => {
    const { tab, onRename, onActivate } = setup()
    fireEvent.contextMenu(tab('a'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Rename', 'Pin tab', 'Close tab'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = (await screen.findByLabelText('Rename tab')) as HTMLInputElement
    expect(input.value).toBe('#1 - Alpha')
    expect(tab('a').getAttribute('draggable')).toBe('false')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledExactlyOnceWith('a', 'Renamed')
    expect(screen.queryByLabelText('Rename tab')).toBeNull()
    expect(tab('a').getAttribute('draggable')).toBe('true')
    expect(document.activeElement).toBe(tab('a'))
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('cancels on Escape', async () => {
    const { tab, onRename } = setup()
    fireEvent.contextMenu(tab('b'), { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByLabelText('Rename tab')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Rename tab')).toBeNull()
  })

  it('edits on F2 when the tab has focus', () => {
    const { tab } = setup()
    fireEvent.keyDown(tab('b'), { key: 'F2' })
    expect((screen.getByLabelText('Rename tab') as HTMLInputElement).value).toBe('Beta')
  })

  it('has no Rename on a file tab, in its menu or on F2', async () => {
    const { tab } = setup()
    fireEvent.contextMenu(tab('f'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
    fireEvent.keyDown(tab('f'), { key: 'F2' })
    expect(screen.queryByLabelText('Rename tab')).toBeNull()
  })

  it('has no Rename when the strip cannot rename', async () => {
    const { tab } = setup({ onRename: undefined })
    fireEvent.contextMenu(tab('a'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
  })

  it('still closes on Delete when it is not being renamed', () => {
    const { tab, onClose } = setup()
    fireEvent.keyDown(tab('b'), { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('b')
  })
})

describe('a lone pane title bar', () => {
  function actions(rename?: PaneTabActions['rename']): PaneTabActions {
    return { pinned: false, canClose: true, pin: vi.fn(), unpin: vi.fn(), close: vi.fn(), rename }
  }
  function bar(tabActions: PaneTabActions | null, extra: Partial<PaneTabsBinding> = {}) {
    const binding: PaneTabsBinding = { renderStrip: () => null, hasStrips: false, keep: () => {}, shownDoc: () => null, closable: () => true, tabActions: () => tabActions, ...extra }
    return render(
      <PaneTabsContext.Provider value={binding}>
        <ChatPaneTitleBar active title="#7 - Alpha" employee="op" session={{ id: 's1', status: 'idle' }} onClose={vi.fn()} />
      </PaneTabsContext.Provider>,
    )
  }

  it('renames on right-click, Rename, Enter', async () => {
    const rename = vi.fn().mockResolvedValue(undefined)
    bar(actions(rename))
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = (await screen.findByLabelText('Rename tab')) as HTMLInputElement
    expect(input.value).toBe('#7 - Alpha')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(rename).toHaveBeenCalledExactlyOnceWith('Beta')
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.queryByLabelText('Rename tab')).toBeNull()
  })

  it('shows the old title again when the save fails', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('no'))
    bar(actions(rename))
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByLabelText('Rename tab')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('Alpha')).toBeTruthy()
  })

  it('cancels on Escape without saving', async () => {
    const rename = vi.fn()
    bar(actions(rename))
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 10, clientY: 10 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const input = await screen.findByLabelText('Rename tab')
    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(rename).not.toHaveBeenCalled()
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('offers no Rename for a tab that cannot be renamed', async () => {
    bar(actions(undefined))
    fireEvent.contextMenu(screen.getByTestId('chat-pane-title-bar'), { clientX: 10, clientY: 10 })
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Pin tab', 'Close tab'])
  })
})
