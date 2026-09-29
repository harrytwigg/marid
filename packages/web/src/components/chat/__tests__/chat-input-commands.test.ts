import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMANDS, resolveClientCommand } from '../chat-input'

describe('client slash command resolver', () => {
  it('handles view/control commands without sending them as chat prompts', () => {
    expect(resolveClientCommand('/new')).toBe('new')
    expect(resolveClientCommand('/status')).toBe('status')
  })

  it('does not capture engine or skill commands', () => {
    expect(resolveClientCommand('/workflows')).toBeNull()
    expect(resolveClientCommand('/sync @worker')).toBeNull()
    expect(resolveClientCommand('/compact')).toBeNull()
  })

  it('offers /compact in the slash menu but sends it to the gateway', () => {
    expect(BUILTIN_COMMANDS.map((c) => c.name)).toContain('compact')
    expect(resolveClientCommand('/compact keep the Todo ids')).toBeNull()
  })
})
