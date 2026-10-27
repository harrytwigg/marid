import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ApiError } from '@/lib/api'
import { useMobileSessionTabs } from '../use-mobile-session-tabs'
import { MOBILE_TABS_STORAGE_KEY, restoreMobileTabs } from '../mobile-session-tabs-model'

const getSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSession, getSessionMessages: () => new Promise(() => {}) } }
})

const noop = () => {}
const subscribe = () => noop

/** The list carries only `a`: the other tabs' chats are archived, deleted, or past the loaded pages. */
const listed = [{ id: 'a', title: 'Release plan', employee: 'builder' }]

function Strip() {
  const tabs = useMobileSessionTabs({
    committedId: 'a',
    systemPrimedId: null,
    activeId: 'a',
    sessions: listed,
    subscribe,
    connectionSeq: 0,
    onSelect: noop,
    onCloseAll: noop,
  })
  return <div>{tabs.strip}</div>
}

const persisted = () => restoreMobileTabs(localStorage.getItem(MOBILE_TABS_STORAGE_KEY))

describe('the phone tab strip and chats the session list does not carry', () => {
  beforeEach(() => {
    localStorage.clear()
    getSession.mockReset()
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'archived', 'deleted'] }))
  })

  it('keeps an archived chat\'s tab, titled from its lookup, and closes a deleted chat\'s', async () => {
    getSession.mockImplementation((id: string) => (
      id === 'archived'
        ? Promise.resolve({ id, title: 'Old work', archivedAt: '2026-10-20T00:00:00.000Z' })
        : Promise.reject(new ApiError(404, 'not found'))
    ))

    const { container } = render(<Strip />)

    await waitFor(() => expect(persisted()).toEqual(['a', 'archived']))
    await waitFor(() => expect(screen.getByText('Old work')).toBeTruthy())
    expect(container.querySelectorAll('[data-mobile-session-tab]')).toHaveLength(2)
  })
})
