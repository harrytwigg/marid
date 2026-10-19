import { describe, expect, it } from 'vitest'
import type { ResolvedFallbackLink } from '@jinn/fallback-chain-wire'
import {
  blankLink,
  hasLegacyEntries,
  linksOfEntries,
  moveLink,
  noModelLabel,
  profileOptionsFor,
  removeLink,
  replaceLink,
  rowLabel,
  shownChain,
  withEngine,
  withModel,
  writeLinks,
  withProfile,
  type ChainContext,
} from '../chain-links'

const resolved = (engine: string, over: Partial<ResolvedFallbackLink> = {}): ResolvedFallbackLink => ({
  engine, key: engine, account: engine, label: engine, origin: 'config', ...over,
})

describe('normalising a chain', () => {
  it('reads both spellings as links and drops what is neither', () => {
    expect(linksOfEntries(['codex', 'claude:work', { engine: 'opencode', model: ' x/y ' }, 7, '', {}]))
      .toEqual([{ engine: 'codex' }, { engine: 'claude', profile: 'work' }, { engine: 'opencode', model: 'x/y' }])
  })

  it('reads an absent chain as none', () => {
    expect(linksOfEntries(undefined)).toEqual([])
  })

  it('knows a chain with a string entry is legacy', () => {
    expect(hasLegacyEntries(['codex', { engine: 'grok' }])).toBe(true)
    expect(hasLegacyEntries([{ engine: 'grok' }])).toBe(false)
    expect(hasLegacyEntries(undefined)).toBe(false)
  })
})

describe('shownChain', () => {
  it('shows a chain of links as written, with every link written here', () => {
    expect(shownChain([{ engine: 'codex' }, { engine: 'grok', model: 'm' }], undefined)).toEqual({
      links: [{ engine: 'codex' }, { engine: 'grok', model: 'm' }],
      origins: ['config', 'config'],
      legacy: false,
    })
  })

  it('shows a legacy chain as written, not with the models the gateway filled in to run it', () => {
    // ["claude:B", "codex"] on a session model of opus: the gateway resolves claude·B to opus and codex
    // to its model-map translation, but the operator wrote neither model.
    const effective = [
      resolved('claude', { profile: 'B', model: 'opus', key: 'claude|B|opus', written: { engine: 'claude', profile: 'B' } }),
      resolved('codex', { model: 'gpt-mapped', key: 'codex||gpt-mapped', origin: 'legacy', written: { engine: 'codex' } }),
    ]
    const shown = shownChain(['claude:B'], effective)
    expect(shown.links).toEqual([{ engine: 'claude', profile: 'B' }, { engine: 'codex' }])
    // The first edit writes those links, so no model is pinned.
    expect(writeLinks(['claude:B'], [shown.links[1], shown.links[0]])).toEqual([{ engine: 'codex' }, { engine: 'claude', profile: 'B' }])
  })

  it('shows a legacy chain as the gateway expands it, marking the links another chain contributed', () => {
    const effective = [
      resolved('codex', { model: undefined }),
      resolved('claude', { profile: 'work', origin: 'legacy', key: 'claude|work|', label: 'claude · work' }),
    ]
    expect(shownChain(['codex'], effective)).toEqual({
      links: [{ engine: 'codex' }, { engine: 'claude', profile: 'work' }],
      origins: ['config', 'legacy'],
      legacy: true,
    })
  })

  it('falls back to the entries as they read until the gateway has answered', () => {
    expect(shownChain(['codex', 'claude:work'], undefined)).toEqual({
      links: [{ engine: 'codex' }, { engine: 'claude', profile: 'work' }],
      origins: ['config', 'config'],
      legacy: true,
    })
  })

  it('strips what the gateway resolved from a link, leaving the one config would hold', () => {
    const shown = shownChain(['opencode'], [resolved('opencode', { model: 'a/b', skip: 'not-installed', health: { state: 'ok' } })])
    expect(shown.links).toEqual([{ engine: 'opencode', model: 'a/b' }])
  })
})

describe('editing links', () => {
  const links = [{ engine: 'a' }, { engine: 'b' }, { engine: 'c' }]

  it('removes the link at the index and keeps the rest in order', () => {
    expect(removeLink(links, 1)).toEqual([{ engine: 'a' }, { engine: 'c' }])
    expect(removeLink([{ engine: 'a' }], 0)).toEqual([])
  })

  it('moves a link later or earlier, keeping every other relative order', () => {
    expect(moveLink(links, 0, 2).map((l) => l.engine)).toEqual(['b', 'c', 'a'])
    expect(moveLink(links, 2, 0).map((l) => l.engine)).toEqual(['c', 'a', 'b'])
  })

  it('returns the chain unchanged for an index outside it, dropping nothing', () => {
    expect(moveLink(links, 0, 5)).toBe(links)
    expect(moveLink(links, -1, 1)).toBe(links)
    expect(moveLink(links, 1, 1)).toBe(links)
  })

  it('replaces one link without touching the others', () => {
    expect(replaceLink(links, 1, { engine: 'z' }).map((l) => l.engine)).toEqual(['a', 'z', 'c'])
  })

  it('starts a link over on a new engine: a model belongs to one engine and a profile to Claude', () => {
    expect(withEngine({ engine: 'claude', profile: 'work', model: 'opus' }, 'opencode')).toEqual({ engine: 'opencode' })
  })

  it('sets and clears a profile and a model, writing nothing for the empty choice', () => {
    expect(withProfile({ engine: 'claude', model: 'opus' }, 'work')).toEqual({ engine: 'claude', model: 'opus', profile: 'work' })
    expect(withProfile({ engine: 'claude', profile: 'work' }, '')).toEqual({ engine: 'claude' })
    expect(withModel({ engine: 'codex' }, 'gpt-5.5')).toEqual({ engine: 'codex', model: 'gpt-5.5' })
    expect(withModel({ engine: 'codex', model: 'gpt-5.5' }, '')).toEqual({ engine: 'codex' })
  })
})

describe('row options', () => {
  it('offers a profile only on Claude: the default profile and the declared accounts', () => {
    expect(profileOptionsFor('claude', ['work', 'spare'])).toEqual([
      { value: '', label: 'Default profile' },
      { value: 'work', label: 'work' },
      { value: 'spare', label: 'spare' },
    ])
    expect(profileOptionsFor('opencode', ['work'])).toBeNull()
    expect(profileOptionsFor('codex', [])).toBeNull()
  })

  it('names "no model" for what it means: the own model on the own engine, the engine default elsewhere', () => {
    expect(noModelLabel('claude', 'claude')).toBe('Same model')
    expect(noModelLabel('codex', 'claude')).toBe('Engine default')
  })

  it('names a row by its engine, profile and model', () => {
    expect(rowLabel({ engine: 'claude', profile: 'work', model: 'sonnet' })).toBe('Claude · work · sonnet')
    expect(rowLabel({ engine: 'opencode', model: 'x/y' })).toBe('opencode · x/y')
  })
})

describe('blankLink', () => {
  const engine = (name: string) => ({ name, available: true, defaultModel: '', models: [] })
  const ctx: ChainContext = { engines: [engine('claude'), engine('codex'), engine('opencode')], profiles: [] }

  it('starts on the first engine that is neither the chain own target nor already in it', () => {
    expect(blankLink(ctx, [{ engine: 'codex' }], { engine: 'claude' })).toEqual({ engine: 'opencode' })
  })

  it('may start on the own engine for a profile chain, whose own target is a profile', () => {
    expect(blankLink(ctx, [], { engine: 'claude', profile: 'work' })).toEqual({ engine: 'claude' })
  })

  it('starts on a duplicate when nothing else is free, so the row says so', () => {
    const next = blankLink(ctx, [{ engine: 'codex' }, { engine: 'opencode' }], { engine: 'claude' })
    expect(next.engine).not.toBe('claude')
  })
})

describe('writeLinks', () => {
  it('writes an untouched object entry back as that very entry, extra fields and all', () => {
    const raw = { engine: 'opencode', model: 'x/two', note: 'kept' }
    const out = writeLinks([raw, { engine: 'codex', model: 'm' }], [{ engine: 'codex', model: 'm' }, { engine: 'opencode', model: 'x/two' }])
    expect(out[1]).toBe(raw)
    expect(out[0]).toEqual({ engine: 'codex', model: 'm' })
  })

  it('writes a legacy string entry as an object link, never the reverse', () => {
    const out = writeLinks(['codex', 'claude:work', { engine: 'opencode' }], [{ engine: 'codex' }, { engine: 'claude', profile: 'work' }, { engine: 'opencode' }])
    expect(out).toEqual([{ engine: 'codex' }, { engine: 'claude', profile: 'work' }, { engine: 'opencode' }])
    expect(out.every((entry) => typeof entry === 'object')).toBe(true)
  })

  it('writes a new or changed link as a plain object, and uses each untouched entry once', () => {
    const raw = { engine: 'codex' }
    const out = writeLinks([raw], [{ engine: 'codex' }, { engine: 'codex' }, { engine: 'grok' }])
    expect(out[0]).toBe(raw)
    expect(out[1]).toEqual({ engine: 'codex' })
    expect(out[1]).not.toBe(raw)
    expect(out[2]).toEqual({ engine: 'grok' })
  })
})
