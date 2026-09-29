import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { useMobileSessionTabs } from '../use-mobile-session-tabs'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'

// The tabs' preview fetch says nothing about the entrance, and one that never
// settles keeps its state update from landing outside `act`.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionMessages: () => new Promise(() => {}) } }
})

const noop = () => {}
const subscribe = () => noop

const sessions = [
  { id: 'a', title: 'Release plan', employee: 'builder' },
  { id: 'b', title: 'Weekly digest', employee: 'reviewer' },
]

/** The nav bar with the page's own wiring: the tabs hook decides from the chats
 *  opened so far whether the strip gets its row, and the header renders it there
 *  while the centred title stays where it is. */
function NavBar({ title, openedId, loaded = true }: { title: string; openedId: string; loaded?: boolean }) {
  const tabs = useMobileSessionTabs({
    committedId: openedId,
    systemPrimedId: null,
    activeId: openedId,
    sessions: loaded ? sessions : undefined,
    subscribe,
    connectionSeq: 0,
    onSelect: noop,
  })
  return <ChatHeaderPills title={title} onNew={noop} onBack={noop} mobileWorkingSet={tabs} />
}

const entering = (container: HTMLElement) => container.querySelectorAll('[data-title-enter]')
const tabsUp = (container: HTMLElement) => container.querySelector('[data-mobile-session-tab]') !== null
/** The centred nav-bar title. */
const centredTitle = (container: HTMLElement) => container.querySelector('span.text-center')

describe('chat title entrance while the session strip comes and goes', () => {
  beforeEach(() => localStorage.clear())

  it('waits for the session list before showing the strip, so no tab ever reads "Chat"', () => {
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b'] }))
    const { container, rerender } = render(<NavBar title="Release plan" openedId="a" loaded={false} />)
    expect(tabsUp(container)).toBe(false)

    rerender(<NavBar title="Release plan" openedId="a" />)
    expect(Array.from(container.querySelectorAll('[data-mobile-session-tab]')).map((tab) => tab.textContent)).toEqual(['Release plan', 'Weekly digest'])
  })

  it('keeps the one centred title mounted, so a strip appearing never interrupts or replays its entrance', () => {
    const { container, rerender } = render(<NavBar title="Release plan" openedId="a" />)
    const title = centredTitle(container)
    expect(tabsUp(container)).toBe(false)
    expect(entering(container)).toHaveLength(0)

    // The reader watches this one arrive, so it animates.
    rerender(<NavBar title="Weekly digest" openedId="a" />)
    expect(entering(container)).toHaveLength(1)

    // A second chat is opened: the strip takes its own row and the title stays
    // put, still mid-entrance, instead of being unmounted under it.
    rerender(<NavBar title="Weekly digest" openedId="b" />)
    expect(tabsUp(container)).toBe(true)
    expect(centredTitle(container)).toBe(title)
    expect(entering(container)).toHaveLength(1)

    // The second tab is closed and the first chat is back in front: the strip
    // stands down, and the title is the same node with nothing replayed.
    fireEvent.click(screen.getByRole('button', { name: 'Close Weekly digest' }))
    rerender(<NavBar title="Weekly digest" openedId="a" />)
    expect(tabsUp(container)).toBe(false)
    expect(centredTitle(container)).toBe(title)
    expect(entering(container)).toHaveLength(1)
  })
})
