import { describe, expect, it } from 'vitest'
import {
  clearMobileWorkingSetMoved,
  mobileWorkingSetIds,
  reduceMobileWorkingSetActivity,
  type MobileWorkingSetActivity,
} from '../mobile-working-set-activity'

describe('mobile working-set activity', () => {
  it('fills four fixed slots without changing existing presentation order', () => {
    const sessions = [
      { id: 'd' },
      { id: 'c' },
      { id: 'b' },
      { id: 'a' },
      { id: 'e' },
    ]

    expect(mobileWorkingSetIds(['a', 'c'], sessions)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps the focused chat and every session-backed member on the strip', () => {
    const sessions = ['s5', 's8', 's1', 's2', 's3'].map((id) => ({ id }))

    const ids = mobileWorkingSetIds(['s1', 's2'], sessions, ['s5', 's8', 's1', 's2'], 's3')

    expect(ids).toEqual(expect.arrayContaining(['s1', 's2', 's3']))
  })

  it('retains filled slot identities when focus moves to an existing slot', () => {
    const sessions = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
    ]
    const before = mobileWorkingSetIds(['a', 'b'], sessions)

    expect(mobileWorkingSetIds(['d', 'b'], sessions, before, 'd')).toEqual(before)
  })

  it('changes exactly one trailing non-required slot for an off-strip focus', () => {
    const previous = ['s5', 's8', 's7', 's6']
    const sessions = [...previous, 's1'].map((id) => ({ id }))

    const next = mobileWorkingSetIds(['s1'], sessions, previous, 's1')
    const changedSlots = next.filter((id, index) => id !== previous[index])

    expect(next).toEqual(['s5', 's8', 's7', 's1'])
    expect(changedSlots).toHaveLength(1)
  })

  it('keeps surviving slots at their indices when it fills a vacancy', () => {
    const sessions = ['s5', 's7', 's6', 's1'].map((id) => ({ id }))

    expect(mobileWorkingSetIds(['s1'], sessions, ['s5', 'missing', 's7', 's6'], 's1'))
      .toEqual(['s5', 's1', 's7', 's6'])
  })

  it('fills a vacancy with a chat the operator opened over a busier one they never opened', () => {
    // 'busy' leads the session list because the gateway has just written to it;
    // 'opened' is the one the operator actually put on screen.
    const sessions = ['busy', 'opened', 's1', 's2', 's3'].map((id) => ({ id }))

    expect(mobileWorkingSetIds(['s1'], sessions, ['s1', 's2', 's3'], 's1', ['opened']))
      .toEqual(['s1', 's2', 's3', 'opened'])
    expect(mobileWorkingSetIds(['s1'], sessions, ['s1', 's2', 's3'], 's1'))
      .toEqual(['s1', 's2', 's3', 'busy'])
  })

  it('evicts the least recently touched slot for an off-strip open', () => {
    const previous = ['s5', 's8', 's7', 's6']
    const sessions = [...previous, 's1'].map((id) => ({ id }))
    // Most recent first, and 's5' was never opened at all.
    const touchOrder = ['s1', 's6', 's7', 's8']

    const next = mobileWorkingSetIds(['s1'], sessions, previous, 's1', touchOrder)

    expect(next).toEqual(['s1', 's8', 's7', 's6'])
    expect(next.filter((id, index) => id !== previous[index])).toHaveLength(1)
  })

  it('returns at most four unique session-backed ids', () => {
    const sessions = ['s1', 's2', 's3'].map((id) => ({ id }))
    const ids = mobileWorkingSetIds(
      ['ghost', 's1', 's1'],
      sessions,
      ['ghost', 's1', 's1', 'missing'],
      'ghost',
    )
    const availableIds = new Set(sessions.map(({ id }) => id))

    expect(ids.length).toBeLessThanOrEqual(4)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => availableIds.has(id))).toBe(true)
  })

  it('cross-fades once per message while appending streamed chunks without duplication', () => {
    const initial: Record<string, MobileWorkingSetActivity> = {}
    const first = reduceMobileWorkingSetActivity(initial, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text', content: 'work' },
    })
    const second = reduceMobileWorkingSetActivity(first, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text', content: 'ing' },
    })
    const snapshot = reduceMobileWorkingSetActivity(second, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'b', type: 'text_snapshot', content: 'working safely' },
    })

    expect(first.b).toMatchObject({ preview: 'Work', revision: 1, moved: true, receivingText: true })
    expect(second.b).toMatchObject({ preview: 'Working', revision: 1, moved: true, receivingText: true })
    expect(snapshot.b).toMatchObject({ preview: 'Working safely', revision: 1, moved: true })
  })

  it('starts a new revision for complete messages, ignores outsiders, and clears moved on focus', () => {
    const initial: Record<string, MobileWorkingSetActivity> = {}
    const ignored = reduceMobileWorkingSetActivity(initial, ['a', 'b'], 'a', {
      event: 'session:delta',
      payload: { sessionId: 'outside', type: 'text', content: 'nope' },
    })
    const notified = reduceMobileWorkingSetActivity(ignored, ['a', 'b'], 'a', {
      event: 'session:notification',
      payload: { sessionId: 'b', content: 'background finished' },
    })

    expect(ignored).toBe(initial)
    expect(notified.b).toMatchObject({ preview: 'Background finished', revision: 1, moved: true, receivingText: false })
    expect(clearMobileWorkingSetMoved(notified, 'b').b.moved).toBe(false)
  })

  it('previews a notification from the field the gateway actually sends', () => {
    const initial: Record<string, MobileWorkingSetActivity> = {}
    const notified = reduceMobileWorkingSetActivity(initial, ['a', 'b'], 'a', {
      event: 'session:notification',
      payload: { sessionId: 'b', message: '🗜️ Context compacted.' },
    })
    expect(notified.b?.preview).toContain('Context compacted')
  })
})
