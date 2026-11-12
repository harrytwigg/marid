import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Message } from '@/lib/conversations'
import { ChatMessages } from '../chat-messages'

const SWITCH_TEXT = '🔀 Switched from Claude · own login · Opus to Claude · work · Sonnet (requested by this session; carried over by compaction summary)'

const switchNotice = (content = SWITCH_TEXT): Message => ({
  id: 'sw1',
  role: 'notification',
  content,
  timestamp: 1_700_000_000_000,
  meta: { sessionSwitch: { by: 'session', carryOver: 'compaction-summary', from: { engine: 'claude', profile: null, model: 'opus' }, to: { engine: 'claude', profile: 'work', model: 'sonnet' } } },
})

describe('a session switch notice', () => {
  it('renders through the ordinary notification row, with its text', () => {
    const { container } = render(<ChatMessages messages={[switchNotice()]} loading={false} />)
    expect(container.querySelectorAll('.notification-msg-bubble')).toHaveLength(1)
    expect(screen.getByText(SWITCH_TEXT)).toBeTruthy()
  })

  it('renders a notice for a switch that did not happen the same way', () => {
    const text = '🔀 Switch to OpenCode · x did not happen: the engine is no longer installed. Still on Claude · own login · Opus.'
    const { container } = render(<ChatMessages messages={[switchNotice(text)]} loading={false} />)
    expect(container.querySelectorAll('.notification-msg-bubble')).toHaveLength(1)
    expect(screen.getByText(text)).toBeTruthy()
  })
})
