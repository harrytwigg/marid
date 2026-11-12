import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/test/preload-menus'
import type { EnginesResponse } from '@/lib/api'
import { ChainModelSelect } from '../chain-model-select'

/* An opencode link's model select offers the account models the registry lists as
 * `<provider>/<model>` with `account` set, each badged by its account. */

const model = (id: string, label: string, account?: string) => ({ id, label, supportsEffort: false, effortLevels: [], ...(account ? { account } : {}) })

function registry(models: ReturnType<typeof model>[]): EnginesResponse {
  return { default: 'opencode', engines: { opencode: { name: 'opencode', available: true, defaultModel: models[0].id, effortMechanism: 'none', models } } } as EnginesResponse
}

function open(reg: EnginesResponse, value = '', onChange = vi.fn()) {
  render(<ChainModelSelect registry={reg} engine="opencode" value={value} noModelText="Engine default" ariaLabel="Model" onChange={onChange} />)
  fireEvent.keyDown(screen.getByRole('button', { name: /^Model/ }), { key: 'Enter' })
  return onChange
}

describe('chain model select with opencode accounts', () => {
  it('badges an account model with its account and picks it by its provider/model id', () => {
    const onChange = open(registry([
      model('opencode-go/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'go-a'),
      model('opencode-go-b/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 'go-b'),
      model('opencode/big-pickle', 'Big Pickle'),
    ]))

    const badges = Array.from(document.querySelectorAll('[data-account-badge]')).map((b) => b.textContent)
    expect(badges).toEqual(['go-a', 'go-b'])
    const rows = screen.getAllByRole('menuitemradio')
    expect(within(rows[2]).getByText('opencode')).toBeTruthy()   // no account: the provider badge, as before

    fireEvent.click(rows[1])
    expect(onChange).toHaveBeenCalledWith('opencode-go-b/deepseek-v4.1-flash')
  })

  it('finds an account model by its account name in the search', () => {
    open(registry([model('opencode-go/a', 'Alpha', 'go-a'), model('opencode-go-b/a', 'Alpha', 'workspace-two')]))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'workspace-two' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
  })

  it('renders a registry with no accounts exactly as before: provider badges, no account badge', () => {
    open(registry([model('opencode-go/a', 'Alpha'), model('opencode/b', 'Beta')]))
    expect(document.querySelector('[data-account-badge]')).toBeNull()
    expect(screen.getByText('opencode go')).toBeTruthy()
  })
})
