import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mount } from './session-waits-fixtures'

// A chunk gone stale after a deploy: the dynamic import of the popup's code rejects.
vi.mock('@/components/chat/session-waits-popup', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('the waiting-on popup when its code cannot load', () => {
  it('fails inside the popup, which stays closable, and leaves the status and its surroundings up', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    mount()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /working|employees/i })

    await user.click(trigger)

    expect(await screen.findByText(/Could not load what this session is waiting on/)).toBeTruthy()
    expect(screen.getByTestId('background-activity-status')).toBeTruthy()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    errors.mockRestore()
  })
})
