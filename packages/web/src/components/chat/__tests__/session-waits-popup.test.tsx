import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { EMPTY_CLOSE_MS } from '../session-waits-popup'
import {
  Harness, PARENT, builder, getSessionWaits, monitor, mount, openPopup, respond, reviewer,
} from './session-waits-fixtures'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionWaits: vi.fn() } }
})

describe('the waiting-on status as a button', () => {
  beforeEach(() => { getSessionWaits().mockReset() })
  afterEach(() => vi.useRealTimers())

  it('does not fetch until it is opened, and exposes the popup to assistive tech', async () => {
    getSessionWaits().mockResolvedValue(respond([monitor, builder, reviewer]))
    mount()
    const trigger = screen.getByRole('button', { name: /working|employees/i })

    expect(getSessionWaits()).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    // The live region is still the status text.
    expect(screen.getByRole('status').textContent).toContain('2 employees working')

    const { popup } = await openPopup()
    await waitFor(() => expect(getSessionWaits()).toHaveBeenCalledTimes(1))
    expect(getSessionWaits().mock.calls[0][0]).toBe(PARENT)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(popup.id)
  })

  it('opens the child on click, stops the click from reaching the pane, and closes the popup', async () => {
    getSessionWaits().mockResolvedValue(respond([builder, reviewer]))
    const onBarClick = vi.fn()
    const { opener } = mount({ onBarClick })
    const { user, popup } = await openPopup()
    onBarClick.mockClear()

    await user.click(within(popup).getByRole('button', { name: /Alpha Reviewer/ }))

    expect(opener).toHaveBeenCalledTimes(1)
    expect(opener).toHaveBeenCalledWith('child-b')
    expect(onBarClick).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says nothing is pending and closes itself shortly after', async () => {
    getSessionWaits().mockResolvedValue(respond([]))
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /working|employees/i }))

    expect(await screen.findByText('Nothing pending')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: EMPTY_CLOSE_MS + 1500 })
  })

  it('says so when the waits cannot be read', async () => {
    getSessionWaits().mockRejectedValue(new Error('404'))
    mount()
    await openPopup()
    expect(await screen.findByText(/Could not load/)).toBeTruthy()
  })

  it('opens from the keyboard, closes on Escape, and returns focus to the button', async () => {
    getSessionWaits().mockResolvedValue(respond([builder]))
    mount()
    const user = userEvent.setup()
    const trigger = screen.getByRole('button', { name: /working|employees/i })

    await user.tab()
    expect(document.activeElement).toBe(trigger)
    await user.keyboard('{Enter}')
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes with the status when the bar goes away', async () => {
    getSessionWaits().mockResolvedValue(respond([builder]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let setActive: (value: boolean) => void = () => {}
    function Toggle() {
      const [active, set] = useState(true)
      setActive = set
      return <Harness opener={vi.fn()} active={active} />
    }
    render(<QueryClientProvider client={client}><MemoryRouter><Toggle /></MemoryRouter></QueryClientProvider>)
    await openPopup()

    act(() => setActive(false))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(screen.queryByTestId('background-activity-status')).toBeNull())

    // The popup does not come back by itself when the status does.
    act(() => setActive(true))
    const trigger = await screen.findByTestId('background-activity-trigger')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still closes after "Nothing pending" while the status keeps re-rendering', async () => {
    getSessionWaits().mockResolvedValue(respond([]))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function Churn() {
      const [, setTick] = useState(0)
      useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), 300)
        return () => window.clearInterval(timer)
      }, [])
      return <Harness opener={vi.fn()} />
    }
    render(<QueryClientProvider client={client}><MemoryRouter><Churn /></MemoryRouter></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /working|employees/i }))

    expect(await screen.findByText('Nothing pending')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: EMPTY_CLOSE_MS + 1500 })
  })
})
