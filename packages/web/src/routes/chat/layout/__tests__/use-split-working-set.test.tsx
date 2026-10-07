import { afterEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from '@testing-library/react'
import { fileTabId } from '../file-tab'
import { createSplitLayout, focusSession, groupOfSession, groupsOf, materializeLayout, openDocTab, placeTab, splitGroup, workingSetFromLayout } from '../split-layout'
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

describe('a file-only pane', () => {
  const report = fileTabId({ path: 'docs/report.md', sessionId: 'a' })

  /** a | b arranged with the report split out to its own pane, as the page leaves it. */
  function storeFilePane() {
    const arranged = materializeLayout(createSplitLayout(['a', 'b'], 'a'), 2)
    const withFile = openDocTab(arranged, 'a', report)
    const layout = splitGroup(withFile, groupOfSession(withFile, 'a')!.id, 'right', report)
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, serializeSplitLayout(layout))
    window.localStorage.setItem(WORKING_SET_STORAGE_KEY, serializeWorkingSet(workingSetFromLayout(layout)))
  }

  it('survives a reload, and the working set the URL syncs from holds chats only', () => {
    storeFilePane()
    const { result } = renderHook(() => useSplitWorkingSet('a', [{ id: 'a' }, { id: 'b' }]))

    expect(groupsOf(result.current.split.layout).map((group) => group.tabs)).toEqual([['a'], [report], ['b']])
    expect(result.current.state.sessionIds).toEqual(['a', 'b'])
    expect(JSON.parse(window.localStorage.getItem(WORKING_SET_STORAGE_KEY)!).sessionIds).toEqual(['a', 'b'])
  })

  it('keeps focus while the URL names a chat already in the layout, and gives it up when the URL moves', () => {
    storeFilePane()
    const sessions = [{ id: 'a' }, { id: 'b' }]
    const { result, rerender } = renderHook(({ id }) => useSplitWorkingSet(id, sessions), { initialProps: { id: 'a' as string | null } })

    act(() => result.current.split.show(report))
    const fileGroup = groupOfSession(result.current.split.layout, report)!
    expect(result.current.split.layout.focusedGroupId).toBe(fileGroup.id)
    // The route is still a chat: the most recent one stands in for the file pane.
    expect(result.current.state.focusedId).not.toBe(report)

    rerender({ id: 'b' })
    expect(result.current.split.layout.focusedGroupId).toBe(groupOfSession(result.current.split.layout, 'b')!.id)
  })
})

describe('a new chat tab', () => {
  it('opened again while it is already shown and focused, in a pane of its own, counts as opened', () => {
    const { result } = renderHook(() => useSplitWorkingSet('a', [{ id: 'a' }, { id: 'b' }]))
    let opened = false
    act(() => { opened = result.current.openNewChat(null) })
    expect(opened).toBe(true)
    const fresh = groupsOf(result.current.split.layout).flatMap((group) => group.tabs).find((id) => id.startsWith('new:'))!
    act(() => result.current.drop(fresh, { region: 'right', key: 'a', groupId: groupOfSession(result.current.split.layout, 'a')!.id }, { columns: 1, cap: 4 }))
    act(() => result.current.split.show(fresh))
    expect(groupOfSession(result.current.split.layout, fresh)!.tabs).toEqual([fresh])

    // Nothing changes, but the new chat is on screen: the caller must not fall back to the route composer.
    act(() => { opened = result.current.openNewChat(null) })
    expect(opened).toBe(true)
    expect(groupsOf(result.current.split.layout).flatMap((group) => group.tabs).filter((id) => id.startsWith('new:'))).toEqual([fresh])
  })

  it('is refused with no chat in the layout, so the route composer is the new chat', () => {
    const { result } = renderHook(() => useSplitWorkingSet(null, []))
    let opened = true
    act(() => { opened = result.current.openNewChat(null) })
    expect(opened).toBe(false)
  })
})

describe('a new chat tab that leaves the layout', () => {
  it('takes its draft with it', () => {
    const { result } = renderHook(() => useSplitWorkingSet('a', [{ id: 'a' }]))
    act(() => { result.current.openNewChat(null) })
    const fresh = groupsOf(result.current.split.layout).flatMap((group) => group.tabs).find((id) => id.startsWith('new:'))!
    const key = Object.keys(window.sessionStorage).find((k) => k.endsWith(fresh))
    expect(key).toBeUndefined()
    const scoped = `jinn-chat-draft:${window.location.origin}:${fresh}`
    window.sessionStorage.setItem(scoped, 'abandoned')
    act(() => result.current.split.close(fresh))
    expect(Object.keys(window.sessionStorage).some((k) => k.endsWith(fresh))).toBe(false)
  })
})
