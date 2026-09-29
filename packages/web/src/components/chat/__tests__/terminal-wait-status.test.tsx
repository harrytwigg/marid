import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionAttentionChips } from '../session-signals'
import { TerminalWaitStatus } from '../terminal-wait-status'

afterEach(cleanup)

describe('TerminalWaitStatus', () => {
  it('says the message is waiting on the terminal and offers Stop', () => {
    const onStop = vi.fn()
    render(<TerminalWaitStatus onStop={onStop} />)
    const status = screen.getByTestId('terminal-wait-status')
    expect(status.getAttribute('role')).toBe('status')
    expect(status.textContent).toContain('Waiting for the turn typed in the terminal')
    expect(status.getAttribute('title')).toMatch(/terminal turn keeps running/)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('SessionAttentionChips while waiting on the terminal', () => {
  it('shows a "waiting on terminal" chip instead of a stall chip', () => {
    render(
      <SessionAttentionChips
        session={{
          id: 's',
          status: 'running',
          turnProgress: { lastProgressAt: Date.now() - 60 * 60_000, awaitingSubmit: false, waitingForTerminalTurn: true },
        }}
      />,
    )
    expect(screen.getByText('waiting on terminal')).toBeTruthy()
    expect(screen.queryByText(/stalled/)).toBeNull()
  })
})
