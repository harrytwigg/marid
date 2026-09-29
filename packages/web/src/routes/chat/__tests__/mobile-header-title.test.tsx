import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

interface TitleFrame { title: string; focusedId: string | null }

// One entry per commit of the header, paired with the pane the phone has on
// screen at that moment — the two things the reader sees at once.
const frames = vi.hoisted(() => [] as TitleFrame[])

// The real header renders underneath, so what the nav bar actually shows is in
// the DOM; the wrapper only records what it was handed.
vi.mock('@/components/chat/chat-tabs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/chat/chat-tabs')>()
  const { useEffect } = await import('react')
  return {
    ...actual,
    ChatHeaderPills: (props: Parameters<typeof actual.ChatHeaderPills>[0]) => {
      useEffect(() => {
        const pane = document.querySelector('[data-chat-pane-session]')
        frames.push({
          title: props.title ?? '',
          focusedId: pane?.getAttribute('data-chat-pane-session') ?? null,
        })
      })
      return <actual.ChatHeaderPills {...props} />
    },
  }
})

import { __clearLiveSessionSnapshotCacheForTests } from '@/hooks/use-live-session'
import { apiMocks, gateway, renderRoute, sessionIds } from './multi-pane-page-harness'
import { WORKING_SET_STORAGE_KEY } from '../working-set'
import { MOBILE_TABS_STORAGE_KEY } from '../mobile-session-tabs-model'

const ALL_TITLES = ['Title a', 'Title b', 'Title c']
const listSessions = apiMocks.getSessions.getMockImplementation()
const oneSession = apiMocks.getSession.getMockImplementation()

function seedWorkingSet(focusedId: string) {
  localStorage.setItem(WORKING_SET_STORAGE_KEY, JSON.stringify({
    version: 1, sessionIds: [focusedId], focusedId, focusHistory: [focusedId],
  }))
}

beforeEach(() => {
  frames.length = 0
  sessionIds.splice(0, sessionIds.length, 'a', 'b', 'c')
  apiMocks.getSessions.mockImplementation(listSessions!)
  apiMocks.getSession.mockImplementation(oneSession!)
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 })
  localStorage.clear()
  gateway.listeners.clear()
  __clearLiveSessionSnapshotCacheForTests()
  seedWorkingSet('a')
  localStorage.setItem(MOBILE_TABS_STORAGE_KEY, JSON.stringify({ version: 1, sessionIds: ['a', 'b', 'c'] }))
})

/** No frame names a chat other than the one it has on screen. A chat still
 *  being named yields '', which belongs to no chat and cannot be mistaken for
 *  one; the nav bar stands its own word in that gap. */
function noFrameMisnamesTheChatOnScreen() {
  expect(frames.length).toBeGreaterThan(0)
  for (const { title, focusedId } of frames) {
    const otherChats = ALL_TITLES.filter((candidate) => candidate !== `Title ${focusedId}`)
    expect(otherChats, `showed "${title}" over chat ${focusedId}`).not.toContain(title)
  }
}

const settledOn = (title: string) =>
  waitFor(() => expect(frames.at(-1)?.title).toBe(title))

describe('mobile chat header title', () => {
  it('names the chat on screen through a repeated switch', async () => {
    renderRoute('/?session=a')
    await settledOn('Title a')

    for (const id of ['b', 'a', 'c']) {
      frames.length = 0
      fireEvent.click(await screen.findByRole('tab', { name: `Title ${id}` }))
      await settledOn(`Title ${id}`)
      noFrameMisnamesTheChatOnScreen()
      expect(frames.at(-1)).toMatchObject({ title: `Title ${id}`, focusedId: id })
    }
  })

  it('names a chat whose own meta never arrives rather than showing another’s', async () => {
    seedWorkingSet('b')
    apiMocks.getSession.mockImplementation(() => new Promise(() => {}))
    renderRoute('/?session=b')

    await settledOn('Title b')
    noFrameMisnamesTheChatOnScreen()
  })

  it('centres a word when nothing names the chat, and still leaves desktop bare', async () => {
    sessionIds.splice(0, sessionIds.length, 'a')
    apiMocks.getSessions.mockImplementation(async () => ({
      sessions: [{ id: 'a', title: '', status: 'idle' }], counts: {}, perGroup: {},
    }))
    apiMocks.getSession.mockImplementation(async (id: string) => ({
      id, title: '', status: 'idle', engine: 'claude', engineSessionId: `engine-${id}`, messages: [],
    }))
    renderRoute('/?session=a')

    // One member, so the chips stand down and the centred title is on screen.
    const navTitle = await screen.findByText('Untitled')
    expect(navTitle.className).toContain('text-center')
    // Desktop guards its title with `{title && …}` and always has: the
    // placeholder belongs to the nav bar, and only one element carries it.
    expect(screen.getAllByText('Untitled')).toHaveLength(1)
  })
})
