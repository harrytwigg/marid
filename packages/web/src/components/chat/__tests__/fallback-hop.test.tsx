import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FallbackHop } from '@jinn/fallback-chain-wire'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'
import { FallbackHopCard, hopSentence, labelOfLinkKey, parseFallbackHop } from '../fallback-hop'
import { servedByLabel } from '../fallback-mode-model'

const resets = new Date()
resets.setHours(16, 0, 0, 0)

const HOP: FallbackHop = {
  at: '2026-10-19T12:00:00Z',
  from: 'claude|A|opus',
  to: 'claude|B|sonnet',
  fromLabel: 'claude · A · opus',
  toLabel: 'claude · B · sonnet',
  reason: 'rate-limit',
  resetsAt: resets.toISOString(),
  skipped: [{ key: 'opencode||x/y', reason: 'not-installed' }],
}

const hopMessage = (hop: unknown = HOP): Message => ({
  id: 'h1', role: 'notification', content: 'Fell back.', timestamp: 1_700_000_000_000, meta: { fallbackHop: hop },
})

describe('parseFallbackHop', () => {
  it('reads the hop a notification carries', () => {
    expect(parseFallbackHop(hopMessage())).toEqual(HOP)
  })

  it('reads none from a plain notification, a malformed hop, or another role', () => {
    expect(parseFallbackHop({ id: 'n', role: 'notification', content: 'Compacted.', timestamp: 1 })).toBeNull()
    expect(parseFallbackHop(hopMessage({ from: 'a' }))).toBeNull()
    expect(parseFallbackHop(hopMessage('nope'))).toBeNull()
    expect(parseFallbackHop({ ...hopMessage(), role: 'assistant' })).toBeNull()
  })
})

describe('hopSentence', () => {
  it('says where it fell back from and to, why, and when the limit resets', () => {
    expect(hopSentence(HOP)).toBe('Fell back from claude · A · opus to claude · B · sonnet: usage limit, resets 16:00')
  })

  it('says the chain ran out, and that the session waits, when there was nowhere to go', () => {
    expect(hopSentence({ ...HOP, to: null, toLabel: null })).toBe(
      'Fallback chain ran out from claude · A · opus: usage limit, resets 16:00. Waiting for it to reset.',
    )
  })

  it('leaves the reset out when the failing target stated none', () => {
    expect(hopSentence({ ...HOP, resetsAt: undefined, reason: 'auth' })).toBe('Fell back from claude · A · opus to claude · B · sonnet: profile signed out')
  })
})

describe('labelOfLinkKey', () => {
  it('reads a key back as the label a row carries', () => {
    expect(labelOfLinkKey('claude|work|sonnet')).toBe('claude · work · sonnet')
    expect(labelOfLinkKey('opencode||x/y')).toBe('opencode · x/y')
    expect(labelOfLinkKey('codex||')).toBe('codex')
  })
})

describe('FallbackHopCard', () => {
  it('is a compact card, with the links passed over behind a toggle', () => {
    render(<FallbackHopCard hop={HOP} />)

    expect(screen.getByText(/Fell back from claude · A · opus to claude · B · sonnet/)).toBeTruthy()
    expect(document.querySelector('[data-fallback-hop-skipped]')).toBeNull()
    const toggle = screen.getByRole('button', { name: '1 passed over' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Passed over opencode · x/y: This engine is not installed')).toBeTruthy()
  })

  it('has no toggle when nothing was passed over', () => {
    render(<FallbackHopCard hop={{ ...HOP, skipped: [] }} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('in the transcript', () => {
  it('renders a hop notification as the card, and a plain one as the bell banner it always was', () => {
    const messages: Message[] = [
      hopMessage(),
      { id: 'n1', role: 'notification', content: 'Session context was compacted.', timestamp: 1_700_000_001_000 },
    ]
    const { container } = render(<ChatMessages messages={messages} loading={false} />)

    expect(container.querySelectorAll('[data-fallback-hop]')).toHaveLength(1)
    expect(container.querySelectorAll('.notification-msg-bubble')).toHaveLength(1)
    expect(screen.getByText('Session context was compacted.')).toBeTruthy()
    expect(screen.queryByText('Fell back.')).toBeNull()
  })
})

describe('servedByLabel', () => {
  const view = (servedBy: string | null) => ({
    mode: 'fallback' as const,
    modeSource: 'default' as const,
    target: null,
    chain: {
      source: 'engine' as const,
      links: [{ engine: 'claude', key: 'claude||opus', account: 'claude', label: 'claude · opus', origin: 'config' as const }],
      position: 0,
      servedBy,
      next: null,
      hops: [],
    },
  })

  it('names the link that served the latest turn, by the label the gateway gave it', () => {
    expect(servedByLabel(view('claude||opus'))).toBe('claude · opus')
  })

  it('reads a key the chain no longer lists as its label', () => {
    expect(servedByLabel(view('opencode||x/y'))).toBe('opencode · x/y')
  })

  it('is null when no turn has run, or the gateway sends no chain', () => {
    expect(servedByLabel(view(null))).toBeNull()
    expect(servedByLabel({ mode: 'fallback', modeSource: 'default', target: null })).toBeNull()
    expect(servedByLabel(null)).toBeNull()
  })
})
