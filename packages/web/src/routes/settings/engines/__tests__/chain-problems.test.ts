import { describe, expect, it } from 'vitest'
import { chainSaveBlocker, rowProblems, validatorContext } from '../chain-problems'
import type { ChainContext } from '../chain-links'

const engine = (name: string) => ({ name, available: true, defaultModel: '', models: [] })
const ctx: ChainContext = { engines: [engine('claude'), engine('codex'), engine('opencode')], profiles: ['work', 'spare'] }
const validator = validatorContext(ctx, { engine: 'claude' })

describe('rowProblems', () => {
  it('is quiet for a chain of distinct targets, including one engine on several profiles and models', () => {
    const links = [
      { engine: 'claude', profile: 'work', model: 'opus' },
      { engine: 'claude', profile: 'spare', model: 'sonnet' },
      { engine: 'opencode', model: 'a/b' },
      { engine: 'opencode', model: 'a/c' },
    ]
    expect(rowProblems('engines.claude.fallback', links, validator)).toEqual({ byRow: [[], [], [], []], general: [] })
  })

  it('refuses a duplicate under the row that repeats it, in the loader sentence', () => {
    const { byRow } = rowProblems('engines.claude.fallback', [{ engine: 'codex' }, { engine: 'codex' }], validator)
    expect(byRow[0]).toEqual([])
    expect(byRow[1]).toEqual(['engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once'])
  })

  it('refuses the target the chain falls back from', () => {
    const { byRow } = rowProblems('engines.claude.fallback', [{ engine: 'claude' }], validator)
    expect(byRow[0][0]).toBe('engines.claude.fallback[0] (claude) is the target this chain falls back from; give it another profile or model')
  })

  it('refuses a profile on an engine that takes none, and one that names no account', () => {
    const links = [{ engine: 'codex', profile: 'work' }, { engine: 'claude', profile: 'ghost' }]
    const { byRow } = rowProblems('fallback', links, validator)
    expect(byRow[0]).toEqual(['fallback[0]: only a claude target takes a profile'])
    expect(byRow[1]).toEqual(['fallback[1]: profile "ghost" names no account under engines.claude.accounts'])
  })

  it('refuses an engine the build does not know', () => {
    const { byRow } = rowProblems('fallback', [{ engine: 'nope' }], validator)
    expect(byRow[0][0]).toBe('fallback[0]: "nope" is not a known engine (claude, codex, opencode)')
  })
})

describe('chainSaveBlocker', () => {
  const registry = { claude: { name: 'claude' }, codex: { name: 'codex' }, opencode: { name: 'opencode' } }

  it('is null for a config whose chains are valid, in either spelling', () => {
    const engines = { claude: { fallback: ['codex', { engine: 'opencode', model: 'a/b' }] } }
    expect(chainSaveBlocker(engines, registry)).toBeNull()
  })

  it('names every refused chain, engine and account, in the loader sentences', () => {
    const engines = {
      claude: {
        fallback: [{ engine: 'codex' }, { engine: 'codex' }],
        accounts: { work: { fallback: [{ engine: 'claude', profile: 'work' }] } },
      },
    }
    expect(chainSaveBlocker(engines, registry)).toBe(
      'Cannot save: engines.claude.fallback[1] duplicates engines.claude.fallback[0] (codex): a chain tries each target once, so list it once; '
      + 'engines.claude.accounts.work.fallback[0] (claude · work) is the target this chain falls back from; give it another profile or model',
    )
  })

  it('asks nothing until the registry has loaded, rather than refusing every engine as unknown', () => {
    expect(chainSaveBlocker({ claude: { fallback: [{ engine: 'codex' }] } }, undefined)).toBeNull()
    expect(chainSaveBlocker({ claude: { fallback: [{ engine: 'codex' }] } }, {})).toBeNull()
  })
})
