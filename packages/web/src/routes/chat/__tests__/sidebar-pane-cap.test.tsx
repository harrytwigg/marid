import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capForViewport } from '../grid-layout'
import { MIN_PANE_WIDTH } from '../layout/split-geometry'
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, NAV_RIBBON_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY } from '../sidebar-width'
import { capWindowWidth, storeSidebarWidth, useSavedSidebarWidth } from '../sidebar-width-store'
import { useChatGridState } from '../use-chat-grid-state'
import type { ChatWorkingSet } from '../working-set'

/** Whole columns of the cap's own arithmetic (grid-layout.ts capForViewport), 376px of chrome. */
const capColumns = (width: number) => Math.max(1, Math.floor((width - 376) / MIN_PANE_WIDTH))

describe('capWindowWidth', () => {
  it('leaves the window alone at or below the default list width', () => {
    expect(capWindowWidth(1440, DEFAULT_SIDEBAR_WIDTH)).toBe(1440)
    expect(capWindowWidth(1440, MIN_SIDEBAR_WIDTH)).toBe(1440)
  })

  it('charges a wider list against the window', () => {
    expect(capWindowWidth(1440, MAX_SIDEBAR_WIDTH)).toBe(1440 - (MAX_SIDEBAR_WIDTH - DEFAULT_SIDEBAR_WIDTH))
  })

  it('never lets the cap allow columns the thread cannot hold at the pane floor', () => {
    for (let windowWidth = 1024; windowWidth <= 2560; windowWidth += 8) {
      for (let list = MIN_SIDEBAR_WIDTH; list <= MAX_SIDEBAR_WIDTH; list += 4) {
        const thread = windowWidth - NAV_RIBBON_WIDTH - list
        const columns = capColumns(capWindowWidth(windowWidth, list))
        // One column is the floor whatever the window; more must fit at MIN_PANE_WIDTH each.
        expect(columns === 1 || columns * MIN_PANE_WIDTH <= thread, `${windowWidth}w list ${list}: ${columns} columns in ${thread}px`).toBe(true)
      }
    }
  })

  it('fewer panes at 1440 with the list at its maximum than at its default', () => {
    expect(capForViewport(capWindowWidth(1440, DEFAULT_SIDEBAR_WIDTH), 900)).toBe(6)
    expect(capForViewport(capWindowWidth(1440, MAX_SIDEBAR_WIDTH), 900)).toBe(4)
  })
})

describe('the grid follows the saved list width', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const workingSet: ChatWorkingSet = { sessionIds: ids, focusedId: 'a', focusHistory: [...ids].reverse() }
  const sessions = ids.map((id) => ({ id }))
  const original = { width: window.innerWidth, height: window.innerHeight }

  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.width })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: original.height })
  })

  it('mounts fewer panes once the list is dragged wide, and all again on reset', () => {
    const { result } = renderHook(() => useChatGridState({ committedId: 'a', workingSet, sessions }))
    expect(result.current.mountedSessionIds).toHaveLength(6)

    act(() => storeSidebarWidth(MAX_SIDEBAR_WIDTH))
    expect(result.current.mountedSessionIds).toHaveLength(4)

    act(() => storeSidebarWidth(null))
    expect(result.current.mountedSessionIds).toHaveLength(6)
  })
})

describe('saved width subscription', () => {
  beforeEach(() => localStorage.clear())

  it('re-renders subscribers when the width is stored or forgotten', () => {
    const { result } = renderHook(() => useSavedSidebarWidth())
    expect(result.current).toBe(DEFAULT_SIDEBAR_WIDTH)
    act(() => storeSidebarWidth(400))
    expect(result.current).toBe(400)
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('400')
    act(() => storeSidebarWidth(null))
    expect(result.current).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})
