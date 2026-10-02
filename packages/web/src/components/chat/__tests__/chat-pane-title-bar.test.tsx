import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TURN_STALL_VISIBLE_MS } from '@/components/chat/session-signals'
import { emojiForName } from '@/lib/emoji-pool'
import { ChatPaneTitleBar } from '../chat-pane-title-bar'

describe('ChatPaneTitleBar', () => {
  it('renders pane identity with a quiet id and a stable trailing cluster', () => {
    render(
      <ChatPaneTitleBar
        active={false}
        title="#42 - Release planning"
        employee="platform-lead"
        session={{ id: 'a', status: 'idle' }}
        onClose={vi.fn()}
      />,
    )

    const bar = screen.getByTestId('chat-pane-title-bar')
    expect(bar.className).toContain('h-[34px]')
    expect(screen.getByText(emojiForName('platform-lead'))).toBeTruthy()
    expect(screen.getByText('#42').className).toContain('text-[var(--text-quaternary)]')
    expect(screen.getByText('Release planning').closest('[data-chat-pane-title]')?.className).toContain('text-[var(--text-tertiary)]')
    expect(screen.getByText('Release planning').closest('[title]')?.getAttribute('title')).toBe('#42 - Release planning')
    expect(screen.getByTestId('chat-pane-title-actions').className).toContain('w-[52px]')
  })

  it('keeps the state dot on hover when there is no close button to give way to', () => {
    const session = { id: 'a', status: 'running' }
    const { rerender } = render(<ChatPaneTitleBar active title="Chat" employee="op" session={session} onClose={vi.fn()} />)
    const slot = () => screen.getByTestId('chat-pane-status-dot').parentElement!.className
    expect(slot()).toContain('group-hover/chat-pane:opacity-0')
    rerender(<ChatPaneTitleBar active title="Chat" employee="op" session={session} />)
    expect(screen.queryByRole('button', { name: 'Close Chat' })).toBeNull()
    expect(slot()).not.toContain('opacity-0')
  })

  it('cross-fades only selection ink and keeps the state dot fully legible', () => {
    const session = { id: 'a', status: 'running' }
    const { rerender } = render(
      <ChatPaneTitleBar active={false} title="Focus work" employee="operator" session={session} onClose={vi.fn()} />,
    )

    const bar = screen.getByTestId('chat-pane-title-bar')
    const emoji = screen.getByText(emojiForName('operator'))
    const title = document.querySelector<HTMLElement>('[data-chat-pane-title]')!
    const dotClass = screen.getByTestId('chat-pane-status-dot').className
    expect(bar.className).toContain('bg-transparent')
    expect(title.className).toContain('text-[var(--text-tertiary)]')
    expect(emoji.className).toContain('opacity-50')
    expect(bar.className).not.toContain('transform')
    expect([bar, emoji, title].map((node) => node.className).join(' ')).not.toMatch(/accent|border|ring|backdrop|blur|translate|scale|transform|veil|gutter/)

    rerender(<ChatPaneTitleBar active title="Focus work" employee="operator" session={session} onClose={vi.fn()} />)
    expect(bar.className).toContain('bg-[var(--fill-secondary)]')
    expect(title.className).toContain('text-[var(--text-primary)]')
    expect(title.className).toContain('font-[var(--weight-medium)]')
    expect(emoji.className).toContain('opacity-100')
    expect(screen.getByTestId('chat-pane-status-dot').className).toBe(dotClass)
  })

  it.each([
    ['running', { id: 'a', status: 'running' }, 'var(--system-blue)', true],
    ['background', { id: 'b', status: 'idle', backgroundActivity: { activeStreams: 1, lastActivityAt: new Date().toISOString() } }, 'var(--system-orange)', true],
  ] as const)('renders the %s state with the shared status dot', (_name, session, color, pulse) => {
    render(<ChatPaneTitleBar active={false} title="Status pane" employee="operator" session={session} onClose={vi.fn()} />)

    const dot = screen.getByTestId('chat-pane-status-dot')
    expect(dot.getAttribute('style')).toContain(`background: ${color}`)
    expect(dot.className.includes('animate-sidebar-pulse')).toBe(pulse)
  })

  it('turns a stalled pane amber without waiting for an unrelated render', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      render(
        <ChatPaneTitleBar
          active={false}
          title="Stalling pane"
          employee="operator"
          session={{ id: 'a', status: 'running', turnProgress: { lastProgressAt: now, awaitingSubmit: false } }}
          onClose={vi.fn()}
        />,
      )
      expect(screen.getByTestId('chat-pane-status-dot').getAttribute('style')).toContain('var(--system-blue)')

      act(() => { vi.advanceTimersByTime(TURN_STALL_VISIBLE_MS + 15_000) })

      expect(screen.getByTestId('chat-pane-status-dot').getAttribute('style')).toContain('var(--system-orange)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders no dot for a resting read pane', () => {
    render(<ChatPaneTitleBar active={false} title="Resting pane" employee="operator" session={{ id: 'a', status: 'idle' }} onClose={vi.fn()} />)

    expect(screen.queryByTestId('chat-pane-status-dot')).toBeNull()
  })

  it('reveals a pane-labelled close control without bubbling pane focus', () => {
    const onClose = vi.fn()
    const onPaneClick = vi.fn()
    render(
      <div onClick={onPaneClick}>
        <ChatPaneTitleBar
          active={false}
          title="Release planning"
          employee="platform-lead"
          session={{ id: 'a', status: 'idle' }}
          onClose={onClose}
        />
      </div>,
    )

    const close = screen.getByRole('button', { name: 'Close Release planning' })
    expect(screen.getByTestId('chat-pane-title-actions').firstElementChild?.className).toContain('group-focus-within/title-actions:opacity-0')
    expect(close.className).toContain('group-hover/chat-pane:opacity-100')
    expect(close.className).toContain('focus-visible:opacity-100')
    expect(close.className).toContain('group-focus-within/title-actions:opacity-100')
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledOnce()
    expect(onPaneClick).not.toHaveBeenCalled()
  })

  it('leads with only its own truncated drill-in back control', () => {
    const onBack = vi.fn()
    const onPaneClick = vi.fn()
    render(
      <div onClick={onPaneClick}>
        <ChatPaneTitleBar
          active
          title="Child thread"
          employee="platform-lead"
          session={{ id: 'child', status: 'idle' }}
          backTo={{ label: 'A parent title long enough to truncate', onClick: onBack }}
          onClose={vi.fn()}
        />
      </div>,
    )

    const back = screen.getByRole('button', { name: 'Back to A parent title long enough to truncate' })
    const label = screen.getByText('A parent title long enough to truncate')
    const emoji = screen.getByText(emojiForName('platform-lead'))
    expect(label.className).toContain('max-w-[90px]')
    expect(label.className).toContain('truncate')
    expect(back.compareDocumentPosition(emoji) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledOnce()
    expect(onPaneClick).not.toHaveBeenCalled()
  })

  it('renames the owning pane immediately through its dropdown', async () => {
    const actions = {
      pinnedIds: new Set<string>(),
      rename: vi.fn(),
      togglePin: vi.fn(),
      duplicate: vi.fn(),
      archive: vi.fn(),
      stop: vi.fn(),
      copyId: vi.fn(),
      delete: vi.fn(),
    }
    vi.spyOn(window, 'prompt').mockReturnValue('New pane title')
    render(
      <ChatPaneTitleBar
        active
        title="Old pane title"
        employee="platform-lead"
        session={{ id: 'pane-c', status: 'idle' }}
        sessionActions={actions}
        onClose={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Actions for Old pane title' })
    expect(trigger.className).toContain('group-focus-within/title-actions:opacity-100')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    expect(actions.rename).toHaveBeenCalledWith('pane-c', 'New pane title')
    expect(document.querySelector('[data-chat-pane-title]')?.getAttribute('title')).toBe('New pane title')
  })

  it('rolls an optimistic pane rename back when persistence fails', async () => {
    const actions = {
      pinnedIds: new Set<string>(),
      rename: vi.fn().mockRejectedValue(new Error('offline')),
      togglePin: vi.fn(),
      duplicate: vi.fn(),
      archive: vi.fn(),
      stop: vi.fn(),
      copyId: vi.fn(),
      delete: vi.fn(),
    }
    vi.spyOn(window, 'prompt').mockReturnValue('Temporary title')
    render(<ChatPaneTitleBar active title="Durable title" employee="operator" session={{ id: 'pane-c' }} sessionActions={actions} onClose={vi.fn()} />)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for Durable title' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))

    await waitFor(() => expect(document.querySelector('[data-chat-pane-title]')?.getAttribute('title')).toBe('Durable title'))
  })
})
