import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackLink } from '@jinn/fallback-chain-wire'
import type { EnginesResponse } from '@/lib/api'
import { ChainEditor } from '../chain-editor'

/* The rows as a keyboard drives them: the order after each press, and where focus is. */

const entry = (name: string) => ({ name, available: true, defaultModel: 'm', effortMechanism: 'none' as const, models: [] })
const REGISTRY: EnginesResponse = {
  default: 'claude',
  engines: { claude: entry('claude'), codex: entry('codex'), opencode: entry('opencode') },
}

let latest: FallbackLink[] = []

function Harness({ initial, serverProblems }: { initial: FallbackLink[]; serverProblems?: string[] }) {
  const [links, setLinks] = useState(initial)
  latest = links
  return (
    <ChainEditor
      chainName="Claude chain"
      ownEngine="claude"
      self={{ engine: 'claude' }}
      where="engines.claude.fallback"
      links={links}
      expanded={links.map(() => false)}
      fields={{ registry: REGISTRY, profiles: ['A'] }}
      waitsAs="Claude"
      serverProblems={serverProblems}
      onChange={setLinks}
    />
  )
}

const order = () => Array.from(document.querySelectorAll('[data-chain-row]')).map((row) => row.getAttribute('data-chain-row'))
const THREE: FallbackLink[] = [{ engine: 'codex' }, { engine: 'opencode' }, { engine: 'claude', profile: 'A' }]

describe('moving a link with the buttons', () => {
  it('moves the same link two places on two presses, with focus following it', () => {
    render(<Harness initial={THREE} />)
    const later = () => screen.getByRole('button', { name: 'Move Codex later in the Claude chain' })

    fireEvent.click(later())
    expect(order()).toEqual(['opencode', 'codex', 'claude · A'])
    expect(document.activeElement).toBe(later())
    expect(document.activeElement?.closest('[data-chain-row]')?.getAttribute('data-chain-row')).toBe('codex')

    fireEvent.click(document.activeElement as HTMLElement)
    expect(order()).toEqual(['opencode', 'claude · A', 'codex'])
    expect(latest).toEqual([{ engine: 'opencode' }, { engine: 'claude', profile: 'A' }, { engine: 'codex' }])
  })

  it('moves a link earlier and keeps focus on the same row when the button it pressed is now disabled', () => {
    render(<Harness initial={THREE} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move opencode earlier in the Claude chain' }))

    expect(order()).toEqual(['opencode', 'codex', 'claude · A'])
    // First row: "earlier" is now disabled, so focus lands on the row's other move button.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move opencode later in the Claude chain')
  })

  it('keeps an edited row where it is, rather than remounting it as another link', () => {
    render(<Harness initial={THREE} />)
    const before = document.querySelectorAll('[data-chain-row]')[1]

    fireEvent.change(screen.getByRole('combobox', { name: 'Engine of link 2 of the Claude chain' }), { target: { value: 'codex' } })

    expect(document.querySelectorAll('[data-chain-row]')[1]).toBe(before)
  })

  it('drops the removed row and leaves the others in place', () => {
    render(<Harness initial={THREE} />)
    const rows = Array.from(document.querySelectorAll('[data-chain-row]'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove opencode from the Claude chain' }))

    expect(order()).toEqual(['codex', 'claude · A'])
    expect(Array.from(document.querySelectorAll('[data-chain-row]'))).toEqual([rows[0], rows[2]])
  })
})

describe('the gateway sentences about a chain', () => {
  it('shows each once, and not again when the editor already shows it under a row', () => {
    const duplicate = 'engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once'
    render(<Harness initial={[{ engine: 'codex' }, { engine: 'codex' }]} serverProblems={[duplicate, 'the gateway says so twice', 'the gateway says so twice']} />)

    expect(screen.getAllByText(duplicate)).toHaveLength(1)
    expect(screen.getAllByText('the gateway says so twice')).toHaveLength(1)
  })
})
