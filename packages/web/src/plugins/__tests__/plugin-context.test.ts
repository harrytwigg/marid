import { describe, expect, it, vi } from 'vitest'
import type { KVStore } from '@/lib/view-mode'
import { contributions } from '@/contrib/registry'
import { createPluginContext, pluginBackendPath } from '../plugin-context'

// The registry is a singleton, so every test invents its own area id and
// disposes what it registered — a shared area would leak between tests exactly
// the way a stale registration leaks in production.
let areaCounter = 0
function freshArea(): string {
  areaCounter += 1
  return `plugin.context.area.${areaCounter}`
}

function fakeStore(seed?: Record<string, string>): KVStore {
  const entries = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

describe('contribution scoping', () => {
  it('namespaces a local id and stamps the plugin as the source', () => {
    const area = freshArea()
    const dispose = createPluginContext('cost-meter').contribute({ id: 'chip', area })

    expect(contributions.getArea(area)).toEqual([
      { id: 'cost-meter:chip', area, source: 'plugin:cost-meter' },
    ])

    dispose()
  })

  // A plugin that could write its own id into the contribution id would be able
  // to land an un-namespaced entry, or one inside another plugin's namespace.
  it.each([
    ['a bare local id', 'chip', 'cost-meter:chip'],
    ['another plugin’s id', 'inbox:chip', 'cost-meter:inbox:chip'],
    ['its own id spelled again', 'cost-meter:chip', 'cost-meter:cost-meter:chip'],
  ])('cannot escape its namespace with %s', (_label, local, expected) => {
    const area = freshArea()
    const dispose = createPluginContext('cost-meter').contribute({ id: local, area })

    expect(contributions.getArea(area).map((entry) => entry.id)).toEqual([expected])

    dispose()
  })

  it('scopes and stamps a batch the same way, under one disposer', () => {
    const area = freshArea()
    const dispose = createPluginContext('inbox').contributeMany([
      { id: 'one', area },
      { id: 'two', area },
    ])

    expect(contributions.getArea(area).map((entry) => [entry.id, entry.source])).toEqual([
      ['inbox:one', 'plugin:inbox'],
      ['inbox:two', 'plugin:inbox'],
    ])

    dispose()
    expect(contributions.getArea(area)).toEqual([])
  })

  it('exposes the source tag it stamps', () => {
    expect(createPluginContext('inbox').source).toBe('plugin:inbox')
  })
})

describe('disposal tracking', () => {
  it('hands every registration’s disposer to the tracker', () => {
    const area = freshArea()
    const tracked: (() => void)[] = []
    const ctx = createPluginContext('inbox', (dispose) => tracked.push(dispose))

    ctx.contribute({ id: 'one', area })
    ctx.contributeMany([{ id: 'two', area }])
    const own = vi.fn()
    ctx.onDispose(own)

    expect(tracked).toHaveLength(3)
    for (const dispose of tracked) dispose()

    expect(contributions.getArea(area)).toEqual([])
    expect(own).toHaveBeenCalledTimes(1)
  })

  it('still returns a working disposer when nothing is tracking', () => {
    const area = freshArea()
    const dispose = createPluginContext('inbox').contribute({ id: 'one', area })

    dispose()

    expect(contributions.getArea(area)).toEqual([])
  })
})

describe('plugin storage', () => {
  it('reads and writes under a key prefixed with the plugin id', () => {
    const store = fakeStore()

    createPluginContext('inbox', undefined, store).storage.set('draft', { body: 'hi' })

    expect(store.getItem('hundredfold.plugin.inbox.draft')).toBe('{"body":"hi"}')
  })

  it('round-trips a value', () => {
    const storage = createPluginContext('inbox', undefined, fakeStore()).storage

    storage.set('count', 3)

    expect(storage.get('count', 0)).toBe(3)
  })

  it('cannot read another plugin’s key', () => {
    const store = fakeStore({ 'hundredfold.plugin.inbox.secret': '"theirs"' })

    expect(createPluginContext('cost-meter', undefined, store).storage.get('secret', 'mine')).toBe(
      'mine',
    )
  })

  it.each([
    ['absent', undefined],
    ['unparseable', '{not json'],
  ])('falls back when the stored value is %s', (_label, stored) => {
    const store = fakeStore(stored === undefined ? {} : { 'hundredfold.plugin.inbox.k': stored })

    expect(createPluginContext('inbox', undefined, store).storage.get('k', 'fallback')).toBe(
      'fallback',
    )
  })

  it('degrades to the fallback when there is no store at all', () => {
    const storage = createPluginContext('inbox', undefined, null).storage

    expect(() => storage.set('k', 1)).not.toThrow()
    expect(storage.get('k', 'fallback')).toBe('fallback')
  })
})

describe('the namespaced backend path', () => {
  it.each([
    ['a leading slash', '/send', '/api/plugins/inbox/send'],
    ['a nested path', '/threads/42/reply', '/api/plugins/inbox/threads/42/reply'],
    ['a query string', '/threads?since=7', '/api/plugins/inbox/threads?since=7'],
    ['a fragment', '/threads#top', '/api/plugins/inbox/threads#top'],
  ])('builds the plugin prefix for %s', (_label, suffix, expected) => {
    expect(pluginBackendPath('inbox', suffix)).toBe(expected)
  })

  // Sanitizing a traversal rewrites the caller's path into a different one and
  // then answers it; throwing is the bug that does not reach production.
  it.each([
    ['a bare parent segment', '/../secrets'],
    ['a parent segment mid-path', '/threads/../../secrets'],
    ['a trailing parent segment', '/threads/..'],
  ])('throws on %s', (_label, suffix) => {
    expect(() => pluginBackendPath('inbox', suffix)).toThrow(/\.\./)
  })

  // Every spelling `fetch` still collapses. A check that reads only the literal
  // form builds a path that looks contained and then lands outside the mount.
  it.each([
    ['a fully encoded parent segment', '/%2e%2e/other/private'],
    ['an upper-case encoding', '/threads/%2E%2E/other/private'],
    ['a half-encoded parent segment', '/.%2e/other/private'],
    ['the other half encoded', '/%2e./other/private'],
  ])('throws on %s', (_label, suffix) => {
    expect(() => pluginBackendPath('inbox', suffix)).toThrow(/\.\./)
  })

  // A backslash separates path segments on an http URL just as `/` does, so a
  // check that splits on `/` alone reads `..\other` as one ordinary name.
  it.each([
    ['a backslash separator', '/..\\other/private'],
    ['a backslash after a half-encoded parent', '/.%2e\\other/private'],
    ['a backslash on both sides', '/threads\\..\\other/private'],
  ])('throws on %s', (_label, suffix) => {
    expect(() => pluginBackendPath('inbox', suffix)).toThrow(/\.\./)
  })

  // The proof that the throw is what contains the request, rather than the
  // prefix: what each built path resolves to is another plugin's mount.
  it.each([
    ['an encoded parent segment', '/api/plugins/inbox/%2e%2e/other/private'],
    ['a backslash separator', '/api/plugins/inbox/..\\other/private'],
  ])('would otherwise have reached another plugin through %s', (_label, built) => {
    expect(new URL(built, 'http://gateway.test').pathname).toBe('/api/plugins/other/private')
  })

  // The rule is about the path, and a query is not one. A plugin passing a
  // relative path as a *value* has done nothing wrong.
  it.each([
    ['a query value', '/threads?path=../elsewhere'],
    ['an encoded query value', '/threads?path=%2e%2e/elsewhere'],
    ['a fragment', '/threads#../elsewhere'],
    ['two dots inside a segment', '/thre..ads'],
    ['three dots', '/%2e%2e%2e/threads'],
    // `%5c` stays a literal in the path rather than separating segments, so
    // `..%5cother` is one ordinary name and reaches nothing but this mount.
    ['an encoded backslash', '/..%5cother/private'],
  ])('does not throw on %s', (_label, suffix) => {
    expect(() => pluginBackendPath('inbox', suffix)).not.toThrow()
  })
})
