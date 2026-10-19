import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChatMessages } from '../chat-messages'

describe('ChatMessages footer', () => {
  it('is the last transcript element and removes the transcript bottom padding', () => {
    const { container } = render(
      <ChatMessages
        messages={[{ id: 'm1', role: 'assistant', content: 'Done', timestamp: 1 }]}
        loading={false}
        footer={<div data-testid="transcript-footer">Footer</div>}
      />,
    )

    const transcript = container.querySelector('.chat-messages-scroll > div')
    expect(transcript?.lastElementChild?.querySelector('[data-testid="transcript-footer"]')).toBeTruthy()
    expect(transcript?.className).toContain('min-h-full')
    expect(transcript?.className).toContain('justify-end')
    // No fixed bottom padding: the footer sits against the composer, which the transcript only clears
    // by the amount the composer overlaps it (0 wherever the composer does not float).
    expect(transcript?.className).not.toMatch(/\bpb-0\b|pb-\[var\(--space-6\)\]/)
    expect(transcript?.className).toContain('pb-[var(--composer-overlap,0px)]')
    expect(transcript?.className).not.toContain('pb-[var(--space-6)]')
  })
})
