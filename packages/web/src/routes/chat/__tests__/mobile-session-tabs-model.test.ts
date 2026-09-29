import { describe, expect, it } from 'vitest'
import {
  MOBILE_TABS_LIMIT,
  closeMobileTab,
  loadPersistedMobileTabs,
  neighbourAfterClose,
  openMobileTab,
  persistMobileTabs,
  restoreMobileTabs,
  serializeMobileTabs,
} from '../mobile-session-tabs-model'

describe('mobile session tabs model', () => {
  it('appends an opened chat and keeps an existing tab where it is', () => {
    expect(openMobileTab(['a'], 'b')).toEqual(['a', 'b'])
    const tabs = ['a', 'b']
    expect(openMobileTab(tabs, 'a')).toBe(tabs)
    expect(openMobileTab(tabs, '  ')).toBe(tabs)
  })

  it('drops the oldest tab when the limit is passed, never the new one', () => {
    const full = Array.from({ length: MOBILE_TABS_LIMIT }, (_, index) => `s${index}`)
    const next = openMobileTab(full, 'new')
    expect(next).toHaveLength(MOBILE_TABS_LIMIT)
    expect(next[0]).toBe('s1')
    expect(next.at(-1)).toBe('new')
  })

  it('closes a tab and leaves the list untouched for an unknown id', () => {
    const tabs = ['a', 'b', 'c']
    expect(closeMobileTab(tabs, 'b')).toEqual(['a', 'c'])
    expect(closeMobileTab(tabs, 'z')).toBe(tabs)
  })

  it('moves focus to the previous tab, else the next, else nowhere', () => {
    expect(neighbourAfterClose(['a', 'b', 'c'], 'b')).toBe('a')
    expect(neighbourAfterClose(['a', 'b', 'c'], 'a')).toBe('b')
    expect(neighbourAfterClose(['a'], 'a')).toBeNull()
    expect(neighbourAfterClose(['a', 'b'], 'z')).toBeNull()
  })

  it('round-trips through storage, deduping and dropping bad payloads', () => {
    expect(restoreMobileTabs(serializeMobileTabs(['a', 'x', 'b', 'a']))).toEqual(['a', 'x', 'b'])
    expect(restoreMobileTabs(null)).toEqual([])
    expect(restoreMobileTabs('not json')).toEqual([])
    expect(restoreMobileTabs(JSON.stringify({ version: 2, sessionIds: ['a'] }))).toEqual([])
  })

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
    }
    expect(() => persistMobileTabs(broken, ['a'])).not.toThrow()
    expect(loadPersistedMobileTabs(broken)).toEqual([])
  })
})
