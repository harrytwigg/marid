import '@/test/preload-menus'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ChatHeaderMenu } from '../chat-header-menu'

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: new Set<string>() }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

function menu(overrides: Partial<Parameters<typeof ChatHeaderMenu>[0]>) {
  return (
    <ChatHeaderMenu
      open={false}
      onOpenChange={vi.fn()}
      selectedId="session-1"
      sessionMeta={{ engine: 'claude' }}
      openGlobalSearch={vi.fn()}
      effectiveViewMode="chat"
      cliModeAvailable
      viewSwitchLocked={false}
      cliTitle={undefined}
      setAndPersistViewMode={vi.fn()}
      onDuplicate={vi.fn()}
      duplicatePending={false}
      onArchive={vi.fn()}
      onUnarchive={vi.fn()}
      onCopyToClipboard={vi.fn()}
      onShareDebugLog={vi.fn()}
      onClearDebugLog={vi.fn()}
      onDeleteSession={vi.fn()}
      onOpenChatBeside={vi.fn()}
      {...overrides}
    />
  )
}

// The route renders the node twice (the desktop bar and the phone bar) over one `open`.
function TwoCopies({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const change = (next: boolean) => { setOpen(next); onOpenChange?.(next) }
  return (
    <>
      <div data-testid="desktop-bar">{menu({ open, onOpenChange: change })}</div>
      <div data-testid="phone-bar">{menu({ open, onOpenChange: change })}</div>
    </>
  )
}

const triggers = () => screen.getAllByRole('button', { name: 'More options' })

describe('ChatHeaderMenu placement', () => {
  it('places one popup against the copy that was pressed, the phone one included', async () => {
    render(<TwoCopies />)
    const [desktop, phone] = triggers()

    fireEvent.pointerDown(phone, { button: 0, ctrlKey: false })
    await screen.findByRole('menu')

    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(phone.getAttribute('aria-expanded')).toBe('true')
    expect(desktop.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes when the pressed copy is hidden by a resize', async () => {
    const onOpenChange = vi.fn()
    render(<TwoCopies onOpenChange={onOpenChange} />)
    fireEvent.pointerDown(triggers()[0], { button: 0, ctrlKey: false })
    await screen.findByRole('menu')

    screen.getByTestId('desktop-bar').style.display = 'none'
    act(() => { window.dispatchEvent(new Event('resize')) })

    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ChatHeaderMenu keys and pending states', () => {
  it('reaches Chat and CLI with the arrow keys', async () => {
    render(menu({ open: true }))
    const list = await screen.findByRole('menu')
    const first = screen.getByRole('menuitem', { name: /Search/ })
    act(() => first.focus())

    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Chat')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('CLI')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toContain('Open beside')
  })

  it('stays open while a duplicate is made, and says so', () => {
    const onOpenChange = vi.fn()
    const onDuplicate = vi.fn()
    const { rerender } = render(menu({ open: true, onOpenChange, onDuplicate }))

    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }))
    expect(onDuplicate).toHaveBeenCalledWith('session-1')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    rerender(menu({ open: true, onOpenChange, onDuplicate, duplicatePending: true }))
    const pending = screen.getByRole('menuitem', { name: /Duplicating/ })
    expect(pending.getAttribute('aria-disabled')).toBe('true')
  })
})
