import { cloneElement, type ReactElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({ children, asChild, ...props }: React.ComponentProps<'button'> & { asChild?: boolean }) =>
    asChild
      ? cloneElement(children as ReactElement, props)
      : <button type="button" {...props}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, asChild, ...props }: React.ComponentProps<'button'> & { asChild?: boolean }) =>
    asChild
      ? cloneElement(children as ReactElement, props)
      : <button type="button" {...props}>{children}</button>,
  ContextMenuSeparator: () => <hr />,
}))

import { SessionRowMenu, sessionMenuCapabilities } from '../session-row-menu'

const runningSession = {
  id: 'session-42',
  status: 'running',
}

describe('sessionMenuCapabilities', () => {
  it('offers stop only for a running session', () => {
    expect(sessionMenuCapabilities(runningSession)).toEqual({ canStop: true })
    expect(sessionMenuCapabilities({ id: 'idle-session', status: 'idle' })).toEqual({ canStop: false })
  })
})

describe.each(['dropdown', 'context'] as const)('SessionRowMenu %s variant', (variant) => {
  const onRename = vi.fn()
  const onTogglePin = vi.fn()
  const onDuplicate = vi.fn()
  const onArchive = vi.fn()
  const onStop = vi.fn()
  const onDelete = vi.fn()
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
  })

  it('keeps existing actions and adds stop and copy actions', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <SessionRowMenu
          variant={variant}
          session={runningSession}
          isPinned={false}
          isArchived={false}
          onRename={onRename}
          onTogglePin={onTogglePin}
          onDuplicate={onDuplicate}
          onArchive={onArchive}
          onStop={onStop}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pin' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Duplicate…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy Session ID' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Delete session/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }))
    fireEvent.click(screen.getByRole('button', { name: /^Delete session/ }))
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onTogglePin).toHaveBeenCalledTimes(1)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Stop session' }))
    expect(onStop).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Copy Session ID' }))
    expect(writeText).toHaveBeenCalledWith('session-42')
  })

  it('withholds the stop action from an idle session', () => {
    render(
      <MemoryRouter>
        <SessionRowMenu
          variant={variant}
          session={{ id: 'web-session', status: 'idle' }}
          isPinned
          isArchived
          onRename={onRename}
          onTogglePin={onTogglePin}
          onDuplicate={onDuplicate}
          onArchive={onArchive}
          onStop={onStop}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('button', { name: 'Unpin' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unarchive chat' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Stop session' })).toBeNull()
  })
})
