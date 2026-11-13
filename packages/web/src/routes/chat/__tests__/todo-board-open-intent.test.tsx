import { describe, expect, it, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTodoBoardOpenIntent, useTodoBoardTabPinner } from '../use-layout-tab-openers'

/* The `?open=todo-board:<id>` link, on a data router: its navigations are asynchronous, so a drop of the intent that
 * raced another move would show here (a MemoryRouter would hide it). */

function Where() {
  const location = useLocation()
  return <span data-testid="where">{location.pathname}{location.search}</span>
}

function mount(entry: string, ui: ReactNode) {
  const routes: RouteObject[] = [{ path: '*', element: <>{ui}<Where /></> }]
  const router = createMemoryRouter(routes, { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
  return router
}

function Intent({ open, ready, mobile }: { open: (id: string) => boolean; ready: boolean; mobile: boolean }) {
  useTodoBoardOpenIntent({ open, ready, mobile })
  return null
}

const where = () => screen.getByTestId('where').textContent

describe('the sub-board tab link', () => {
  it('opens the tab once the layout is ready, then leaves the address without it, by a replace', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?session=s1&open=todo-board:ACM-7', <Intent open={open} ready mobile={false} />)
    await waitFor(() => expect(where()).toBe('/?session=s1'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('ACM-7')
    // A replace: there is no entry to go back to that would replay it.
    expect(router.state.historyAction).toBe('REPLACE')
    expect(router.state.location.search).toBe('?session=s1')
  })

  it('waits for the layout, and leaves the link in the address until it has opened the tab', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?open=todo-board:ACM-7', <Intent open={open} ready={false} mobile={false} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(open).not.toHaveBeenCalled()
    expect(router.state.location.search).toBe('?open=todo-board:ACM-7')
  })

  it('opens nothing for a link that names no Todo, and drops it from the address all the same', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?open=todo-board:nope&view=x', <Intent open={open} ready mobile={false} />)
    await waitFor(() => expect(where()).toBe('/?view=x'))
    expect(open).not.toHaveBeenCalled()
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('drops a link that names no Todo even before the layout is ready, and on a phone', async () => {
    const open = vi.fn(() => false)
    mount('/?open=todo-board:nope', <Intent open={open} ready={false} mobile />)
    await waitFor(() => expect(where()).toBe('/'))
    expect(open).not.toHaveBeenCalled()
  })

  it('leaves the address as the opener set it when the opener moved the route itself', async () => {
    const open = vi.fn(() => true)
    const router = mount('/?open=todo-board:ACM-7', <Intent open={open} ready mobile={false} />)
    await waitFor(() => expect(open).toHaveBeenCalledWith('ACM-7'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(open).toHaveBeenCalledTimes(1)
    // The opener's own move is the address now; the hook writes nothing over it.
    expect(router.state.location.search).toBe('?open=todo-board:ACM-7')
  })

  it('takes a phone to the Todo\'s page with its board open, there being no tab to put it in', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?open=todo-board:ACM-7', <Intent open={open} ready={false} mobile />)
    await waitFor(() => expect(where()).toBe('/todos/ACM-7?view=board'))
    expect(open).not.toHaveBeenCalled()
    expect(router.state.historyAction).toBe('REPLACE')
  })
})

describe('the pinner the chat page hands the board pop-up', () => {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const router = createMemoryRouter([{ path: '*', element: <>{children}</> }], { initialEntries: ['/'] })
    return <RouterProvider router={router} />
  }

  it('pins on a desktop, and says so', () => {
    const pin = vi.fn(() => false)
    const { result } = renderHook(() => useTodoBoardTabPinner(pin, { mobile: false, hydrated: true }), { wrapper })
    expect(result.current('ACM-7')).toBe(true)
    expect(pin).toHaveBeenCalledWith('ACM-7')
  })

  it('declines on a phone, which has no tab to pin to', () => {
    const pin = vi.fn(() => false)
    const { result } = renderHook(() => useTodoBoardTabPinner(pin, { mobile: true, hydrated: true }), { wrapper })
    expect(result.current('ACM-7')).toBe(false)
    expect(pin).not.toHaveBeenCalled()
  })
})
