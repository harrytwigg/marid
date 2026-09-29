import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createSplitLayout, focusSession, groupOfSession, groupsOf, placeTab, workingSetFromLayout } from '../split-layout'
import { SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout } from '../split-layout-storage'
import { WORKING_SET_STORAGE_KEY, serializeWorkingSet } from '../../working-set'
import { deletedWhileClosed, useSplitWorkingSet } from '../use-split-working-set'

/** A pane holding [a, x] with x shown and focused, stored as the page leaves it. */
function storeTabbedPane() {
  let layout = createSplitLayout(['a'], 'a')
  layout = focusSession(placeTab(layout, groupOfSession(layout, 'a')!.id, 'x'), 'x')
  window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
  window.localStorage.setItem(WORKING_SET_STORAGE_KEY, serializeWorkingSet(workingSetFromLayout(layout)))
}

afterEach(() => window.localStorage.clear())

describe('a chat deleted while the page was closed', () => {
  it('is what the stored layout holds and the session list does not', () => {
    storeTabbedPane()

    expect([...deletedWhileClosed(window.localStorage, new Set(['a']))]).toEqual(['x'])
    expect(deletedWhileClosed(window.localStorage, new Set(['a', 'x'])).size).toBe(0)
  })

  it('is not opened over the survivor of its group when a restored tab puts it in the URL', () => {
    storeTabbedPane()
    // A bare visit: the open-chats list restores x into the URL before the session list arrives.
    const { result, rerender } = renderHook(
      ({ id, sessions }) => useSplitWorkingSet(id, sessions),
      { initialProps: { id: null as string | null, sessions: undefined as Array<{ id: string }> | undefined } },
    )
    rerender({ id: 'x', sessions: undefined })
    rerender({ id: 'x', sessions: [{ id: 'a' }] })

    expect(groupsOf(result.current.split.layout).map((group) => group.tabs)).toEqual([['a']])
    expect(result.current.state).toMatchObject({ sessionIds: ['a'], focusedId: 'a' })
  })

  it('does not count the chat the page was loaded on, which may just be older than the session list', () => {
    storeTabbedPane()
    const { result } = renderHook(() => useSplitWorkingSet('x', [{ id: 'a' }]))

    expect(groupsOf(result.current.split.layout).map((group) => group.tabs)).toEqual([['a', 'x']])
    expect(result.current.state).toMatchObject({ focusedId: 'x' })
  })

  it('is not opened when the URL names it after the layout has loaded', () => {
    storeTabbedPane()
    const { result, rerender } = renderHook(({ id }) => useSplitWorkingSet(id, [{ id: 'a' }]), { initialProps: { id: null as string | null } })
    rerender({ id: 'x' })

    expect(groupsOf(result.current.split.layout).map((group) => group.tabs)).toEqual([['a']])
  })

  it('opens again once the URL has moved on, so a deliberate open still works', () => {
    storeTabbedPane()
    const { result, rerender } = renderHook(({ id }) => useSplitWorkingSet(id, [{ id: 'a' }, { id: 'b' }]), { initialProps: { id: null as string | null } })
    rerender({ id: 'x' })
    expect(groupsOf(result.current.split.layout).flatMap((group) => group.tabs)).not.toContain('x')
    rerender({ id: 'b' })
    rerender({ id: 'x' })

    expect(groupsOf(result.current.split.layout).flatMap((group) => group.tabs)).toContain('x')
  })
})
