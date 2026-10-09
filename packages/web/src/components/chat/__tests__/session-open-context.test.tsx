import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SessionRef } from '@/routes/todos/task-page/session-ref'
import { LayoutOpenProviders, SessionOpenContext, useOpenSession } from '../file-open-context'

function Link({ id }: { id: string }) {
  const open = useOpenSession()
  return <button type="button" onClick={() => open(id)}>open {id}</button>
}

function Where() {
  const { pathname, search } = useLocation()
  return <output data-testid="where">{pathname}{search}</output>
}

describe('useOpenSession', () => {
  it('hands the session to the chat layout when it provides an opener, without navigating', () => {
    const opener = vi.fn()
    render(
      <MemoryRouter initialEntries={['/todos/X-1']}>
        <SessionOpenContext.Provider value={opener}><Link id="s1" /></SessionOpenContext.Provider>
        <Where />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('open s1'))
    expect(opener).toHaveBeenCalledWith('s1')
    expect(screen.getByTestId('where').textContent).toBe('/todos/X-1')
  })

  it('goes to the chat route outside the layout', () => {
    render(
      <MemoryRouter initialEntries={['/todos/X-1']}>
        <Link id="s 2" />
        <Where />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByText('open s 2'))
    expect(screen.getByTestId('where').textContent).toBe('/?session=s%202')
  })

  it('is what a Todo\'s session reference opens through', () => {
    const session = vi.fn()
    render(
      <MemoryRouter initialEntries={['/todos/X-1']}>
        <LayoutOpenProviders file={() => false} todo={() => false} session={session}>
          <SessionRef sessionId="s3" byName={new Map()} />
        </LayoutOpenProviders>
        <Where />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByTestId('session-ref-s3'))
    expect(session).toHaveBeenCalledWith('s3')
    expect(screen.getByTestId('where').textContent).toBe('/todos/X-1')
  })
})
