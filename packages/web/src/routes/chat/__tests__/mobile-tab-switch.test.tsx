import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { MultiChatGrid } from '../multi-chat-grid'
import { useMobileSessionTabs } from '../use-mobile-session-tabs'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionMessages: () => new Promise(() => {}) } }
})

vi.mock('@/components/chat/chat-pane', () => ({
  ChatPane: ({ sessionId }: { sessionId: string | null }) => <output>{sessionId ?? 'new'}</output>,
}))

const noop = () => {}
const subscribe = () => noop

const sessions = [
  { id: 'a', title: 'Release plan', employee: 'builder' },
  { id: 'b', title: 'Weekly digest', employee: 'reviewer' },
  { id: 'c', title: 'Nightly build', employee: 'builder' },
]
const titles: Record<string, string> = { a: 'Release plan', b: 'Weekly digest', c: 'Nightly build' }

interface PhoneProps {
  /** The page ignores a tab press: navigation that ends with the same chat in front. */
  ignoreSelect?: boolean
  /** This chat's title is not known when it comes forward and arrives a fetch later. */
  lateTitleFor?: string
}

/** The phone page's wiring for the two things a switch used to replay: the nav bar's title, which
 *  the tabs hook feeds a strip, and the thread wrapper the grid puts around the shown chat.
 *  "Open from list" is the other way a chat comes forward, with no tab press behind it. */
function Phone({ ignoreSelect = false, lateTitleFor }: PhoneProps) {
  const [openedId, setOpenedId] = useState('a')
  const [titleLoaded, setTitleLoaded] = useState(false)
  const [renamed, setRenamed] = useState(false)
  const title = openedId === lateTitleFor && !titleLoaded ? '' : `${titles[openedId]}${renamed ? ' (renamed)' : ''}`
  const tabs = useMobileSessionTabs({
    committedId: openedId,
    systemPrimedId: null,
    activeId: openedId,
    sessions,
    subscribe,
    connectionSeq: 0,
    onSelect: ignoreSelect ? noop : setOpenedId,
  })
  const primary = { paneKey: openedId, sessionId: openedId, pendingUserMessage: undefined, initialEmployee: undefined, onSessionCreated: noop, viewMode: 'chat' as const, focusTrigger: 0, delegatedActivity: undefined }
  return (
    <>
      <ChatHeaderPills title={title} chatId={openedId} onNew={noop} onBack={noop} mobileWorkingSet={tabs} />
      <MultiChatGrid
        sessionIds={[openedId]}
        focusedId={openedId}
        primary={primary}
        viewport={{ width: 390, height: 844, mobile: true }}
        metaById={{}}
        sessionTitleFor={() => undefined}
        runtime={{ portalName: 'Gateway', subscribe, events: [] }}
        scrollTopFor={() => undefined}
        viewModeFor={() => 'chat'}
        focusTriggerFor={() => 0}
        delegatedActivityFor={() => undefined}
        onFocus={noop}
        onRemove={noop}
        onMeta={noop}
        onNewMeta={noop}
        onOpenFile={noop}
        onPeek={noop}
        onNewChat={noop}
        onRefresh={noop}
        onContentReady={noop}
        onStartFreshChat={async () => {}}
      />
      <button type="button" onClick={() => setOpenedId(openedId === 'a' ? 'b' : 'a')}>Open from list</button>
      <button type="button" onClick={() => setOpenedId('c')}>Open Nightly build from list</button>
      <button type="button" onClick={() => setTitleLoaded(true)}>Title loads</button>
      <button type="button" onClick={() => setRenamed(true)}>Rename</button>
    </>
  )
}

const thread = () => document.querySelector<HTMLElement>('[data-mobile-thread-pane]')!
const fades = (el: HTMLElement) => el.className.includes('jinn-mobile-chat-crossfade')
const titleEntering = () => document.querySelectorAll('[data-title-enter]').length
const press = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))

describe('switching phone tabs', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b'] }))
  })

  it('shows the other chat with no crossfade and no title entrance', () => {
    render(<Phone />)
    const first = thread()
    expect(fades(first)).toBe(true)

    press('Weekly digest')

    expect(thread().dataset.mobileThreadPane).toBe('b')
    expect(thread()).not.toBe(first)
    expect(fades(thread())).toBe(false)
    expect(screen.getByText('Weekly digest', { selector: 'span.text-center' })).toBeTruthy()
    expect(titleEntering()).toBe(0)
  })

  it('counts closing the tab in front as a switch to the chat beside it', () => {
    render(<Phone />)
    press('Weekly digest')
    fireEvent.click(screen.getByRole('button', { name: 'Close Weekly digest' }))
    expect(thread().dataset.mobileThreadPane).toBe('a')
    expect(fades(thread())).toBe(false)
    expect(titleEntering()).toBe(0)
  })

  it('leaves a chat opened from the list with both entrances', () => {
    render(<Phone />)
    fireEvent.click(screen.getByRole('button', { name: 'Open from list' }))

    expect(thread().dataset.mobileThreadPane).toBe('b')
    expect(fades(thread())).toBe(true)
    expect(titleEntering()).toBe(1)
  })

  it('does not carry a switch over to the next chat opened from the list', () => {
    render(<Phone />)
    press('Weekly digest')
    expect(titleEntering()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Open from list' }))
    expect(thread().dataset.mobileThreadPane).toBe('a')
    expect(fades(thread())).toBe(true)
    expect(titleEntering()).toBe(1)
  })

  it('keeps a title that arrives after the switch quiet, for a chat the session list does not hold', () => {
    render(<Phone lateTitleFor="b" />)
    press('Weekly digest')
    expect(fades(thread())).toBe(false)
    expect(titleEntering()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Title loads' }))
    expect(screen.getByText('Weekly digest', { selector: 'span.text-center' })).toBeTruthy()
    expect(titleEntering()).toBe(0)

    // The switch ends with the chat: the next one opened from the list arrives as usual.
    fireEvent.click(screen.getByRole('button', { name: 'Open Nightly build from list' }))
    expect(fades(thread())).toBe(true)
    expect(titleEntering()).toBe(1)
  })

  it('lets a press the page never acted on change nothing about the chat in front or the next open', () => {
    render(<Phone ignoreSelect />)
    press('Weekly digest')
    expect(thread().dataset.mobileThreadPane).toBe('a')

    // A rename of the chat still in front animates: the stale press names another chat.
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(titleEntering()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open Nightly build from list' }))
    expect(fades(thread())).toBe(true)
  })

  it('treats a press on the tab already in front as nothing to carry', () => {
    render(<Phone />)
    press('Release plan')
    fireEvent.click(screen.getByRole('button', { name: 'Open from list' }))

    expect(fades(thread())).toBe(true)
    expect(titleEntering()).toBe(1)
  })
})
