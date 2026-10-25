import { describe, expect, it } from 'vitest'
import { isSessionWaiting, SESSION_WAITING_COLOR, sessionWaitingTitle } from '../session-waiting'

describe('session waiting state', () => {
  it('is only the waiting status', () => {
    expect(isSessionWaiting('waiting')).toBe(true)
    for (const status of ['running', 'idle', 'error', 'interrupted', undefined, null]) {
      expect(isSessionWaiting(status)).toBe(false)
    }
  })

  it('is a warning colour, not the error red', () => {
    expect(SESSION_WAITING_COLOR).toBe('var(--system-yellow)')
  })

  it('titles the dot with the recorded reason, trimmed', () => {
    expect(sessionWaitingTitle('  codex usage limit — waiting for reset ')).toBe('Waiting: codex usage limit — waiting for reset')
  })

  it('falls back to the usage-limit wording when there is no reason', () => {
    for (const lastError of [undefined, null, '', '   ', 42]) {
      expect(sessionWaitingTitle(lastError)).toBe("Waiting: paused until the engine's usage limit resets")
    }
  })
})
