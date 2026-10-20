import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackLink, ResolvedFallbackLink } from '@jinn/fallback-chain-wire'
import { buildChainFlow } from '../chain-flow-model'
import { ChainFlow } from '../chain-flow'
import { plainResolved, resolveForFlow } from '../resolve-links'

const NOW = new Date('2026-10-19T12:00:00').getTime()

const link = (engine: string, over: Partial<ResolvedFallbackLink> = {}, base: FallbackLink = { engine }): ResolvedFallbackLink =>
  ({ ...plainResolved(base), ...over })

const CHAIN: ResolvedFallbackLink[] = [
  link('claude', { label: 'claude · A · opus', key: 'a', health: { state: 'exhausted', until: '2026-10-19T16:00:00', usedPercent: 100, window: '5h' } }),
  link('claude', { label: 'claude · B · sonnet', key: 'b', health: { state: 'ok', usedPercent: 41.6 } }),
  link('opencode', { label: 'opencode · X', key: 'x', skip: 'not-installed' }),
  link('opencode', { label: 'opencode · Y', key: 'y', origin: 'legacy' }),
]

describe('buildChainFlow', () => {
  it('makes one node per target and an "on limit" edge between neighbours', () => {
    const graph = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal')

    expect(graph.nodes.map((n) => n.data.label)).toEqual(['claude · A · opus', 'claude · B · sonnet', 'opencode · X', 'opencode · Y'])
    expect(graph.edges.map((e) => [e.source, e.target, e.label])).toEqual([
      ['0', '1', 'on limit'], ['1', '2', 'on limit'], ['2', '3', 'on limit'],
    ])
    expect(graph.nodes[0].data.own).toBe(true)
    expect(graph.nodes[1].data.own).toBe(false)
  })

  it('reads used percent and the reset from health, the reset only for a target at its limit', () => {
    const [own, second] = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal').nodes
    expect(own.data.used).toBe('100% used')
    expect(own.data.resets).toBe('resets 16:00')
    expect(second.data.used).toBe('42% used')
    expect(second.data.resets).toBeNull()
  })

  it('marks the current target by position and the last server by key', () => {
    const nodes = buildChainFlow({ links: CHAIN, position: 1, servedBy: 'y', now: NOW }, 'horizontal').nodes
    expect(nodes.map((n) => n.data.current)).toEqual([false, true, false, false])
    expect(nodes.map((n) => n.data.servedLast)).toEqual([false, false, false, true])
  })

  it('carries why a link would be skipped, and which came from another chain', () => {
    const nodes = buildChainFlow({ links: CHAIN, now: NOW }, 'horizontal').nodes
    expect(nodes[2].data.skip).toBe('not-installed')
    expect(nodes[2].data.skipText).toBe('This engine is not installed')
    expect(nodes[3].data.legacy).toBe(true)
    expect(nodes[1].data.legacy).toBe(false)
  })

  it('lays out left to right on a wide screen and top to bottom on a phone', () => {
    const wide = buildChainFlow({ links: CHAIN }, 'horizontal').nodes.map((n) => n.position)
    expect(new Set(wide.map((p) => p.y)).size).toBe(1)
    expect(wide[1].x).toBeGreaterThan(wide[0].x)
    const tall = buildChainFlow({ links: CHAIN }, 'vertical').nodes.map((n) => n.position)
    expect(new Set(tall.map((p) => p.x)).size).toBe(1)
    expect(tall[1].y).toBeGreaterThan(tall[0].y)
  })
})

describe('resolveForFlow', () => {
  it('puts the own target first and gives each link what the gateway said of it, plain when it said nothing', () => {
    const known = link('opencode', { key: 'opencode||', health: { state: 'exhausted' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary: null, configured: null, legacy: false, effective: [known] }

    const out = resolveForFlow({ engine: 'claude' }, [{ engine: 'opencode' }, { engine: 'codex' }], subject)

    expect(out.map((l) => l.label)).toEqual(['claude', 'opencode', 'codex'])
    expect(out[1].health?.state).toBe('exhausted')
    expect(out[2].health).toBeUndefined()
  })
})

describe('resolveForFlow, rows with no model', () => {
  it('finds the gateway reading of a row written without a model, by the link as written', () => {
    // The gateway resolves claude·B to the subject's model, so its key carries a model the row does not.
    const exhausted = link('claude', { key: 'claude|B|sonnet', profile: 'B', model: 'sonnet', health: { state: 'exhausted' }, written: { engine: 'claude', profile: 'B' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary: null, configured: null, legacy: false, effective: [exhausted] }

    const out = resolveForFlow({ engine: 'claude' }, [{ engine: 'claude', profile: 'B' }], subject)

    expect(out[1].health?.state).toBe('exhausted')
  })
})

describe('resolveForFlow, own target', () => {
  it('takes the own node from the subject primary, whose key carries the default model, so it keeps its health', () => {
    const primary = link('claude', { key: 'claude||sonnet', model: 'sonnet', label: 'claude · sonnet', health: { state: 'exhausted', usedPercent: 97, window: 'weekly' } })
    const subject = { kind: 'engine' as const, id: 'claude', primary, configured: null, legacy: false, effective: [] }

    const [own] = resolveForFlow({ engine: 'claude' }, [{ engine: 'codex' }], subject)

    expect(own.health?.usedPercent).toBe(97)
    expect(own.label).toBe('claude · sonnet')
  })

  it('falls back to the plain own target when the gateway has not said', () => {
    expect(resolveForFlow({ engine: 'claude' }, [], undefined)[0].label).toBe('claude')
  })
})

describe('ChainFlow', () => {
  async function renderFlow(props: Parameters<typeof ChainFlow>[0]) {
    render(<ChainFlow {...props} />)
    await screen.findAllByText('claude · A · opus')
  }

  it('draws every target with its label, used percent and reset', async () => {
    await renderFlow({ links: CHAIN, now: NOW })

    expect(document.querySelectorAll('[data-chain-flow-node]').length).toBe(4)
    expect(screen.getByText('100% used · resets 16:00')).toBeTruthy()
    expect(screen.getByText('42% used')).toBeTruthy()
  })

  it('highlights the current and last-used target', async () => {
    await renderFlow({ links: CHAIN, position: 1, servedBy: 'b', now: NOW })

    const current = document.querySelector('[data-chain-flow-node][data-current]')!
    expect(current.getAttribute('data-chain-flow-node')).toBe('claude · B · sonnet')
    expect(current.querySelector('[data-chain-flow-badge="now"]')).toBeTruthy()
    expect(current.querySelector('[data-chain-flow-badge="served last"]')).toBeTruthy()
  })

  it('dims a skipped link with its reason, and badges a legacy one', async () => {
    await renderFlow({ links: CHAIN, now: NOW })

    const skipped = document.querySelector('[data-chain-flow-node="opencode · X"]') as HTMLElement
    expect(skipped.getAttribute('data-skipped')).toBe('not-installed')
    expect(skipped.getAttribute('title')).toBe('This engine is not installed')
    expect(skipped.style.opacity).toBe('0.5')
    expect(document.querySelector('[data-chain-flow-node="opencode · Y"] [data-chain-flow-badge="from another chain"]')).toBeTruthy()
    expect((document.querySelector('[data-chain-flow-node="claude · B · sonnet"]') as HTMLElement).style.opacity).toBe('1')
  })
})
