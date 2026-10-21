import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QueuedBar } from '../queued-bar'

describe('QueuedBar', () => {
  it('renders nothing when nothing is queued', () => {
    const { container } = render(<QueuedBar count={0} onSendAllNow={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('clears the floating composer that overlaps whatever sits above it', () => {
    const { container } = render(<QueuedBar count={2} onSendAllNow={vi.fn()} />)
    const bar = container.querySelector('[data-queued-bar]')
    // The composer's negative top margin is --composer-overlap; the strip's bottom margin cancels it,
    // and it stacks above the composer's scrim. Real geometry is checked by the chat-queued capture screen.
    expect(bar?.className).toContain('mb-[var(--composer-overlap,0px)]')
    expect(bar?.className).toContain('z-[12]')
  })

  it('shows the count and force-sends on click', async () => {
    const onSendAllNow = vi.fn().mockResolvedValue(undefined)
    render(<QueuedBar count={2} onSendAllNow={onSendAllNow} />)
    expect(screen.getByText('2 queued, sending after this reply in order')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send all now' }))

    await waitFor(() => expect(onSendAllNow).toHaveBeenCalledTimes(1))
  })

  it('reports a rejected force-send instead of swallowing it', async () => {
    const onSendAllNow = vi.fn().mockRejectedValue(new Error('gateway down'))
    render(<QueuedBar count={1} onSendAllNow={onSendAllNow} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send all now' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Could not send/)).toBeTruthy()
  })

  it('forgets an old failure once the queue empties', async () => {
    const view = render(<QueuedBar count={1} onSendAllNow={vi.fn().mockRejectedValue(new Error('gateway down'))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Send all now' }))
    await screen.findByRole('alert')

    view.rerender(<QueuedBar count={0} onSendAllNow={vi.fn()} />)
    view.rerender(<QueuedBar count={1} onSendAllNow={vi.fn()} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('1 queued, sending after this reply in order')).toBeTruthy()
  })
})
