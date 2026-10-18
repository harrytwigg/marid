import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessages } from '../chat-messages'
import type { OpenSubagentCard } from '../tool-group'
import type { Message } from '@/lib/conversations'

/** The chat's Agent-card entry point to the sub-agent transcript view (#170): clicking a
 *  finished background sub-agent's card opens the same read-only view the waiting-on popup
 *  used to, which is gone once the sub-agent ends. Its own file so the Agent-card concern
 *  does not sit inside the tool-group file, which is already at its recorded size budget. */

function renderChat(messages: Message[], onOpenSubagent?: OpenSubagentCard) {
  return render(
    <MemoryRouter>
      <ChatMessages messages={messages} loading={false} onOpenSubagent={onOpenSubagent} />
    </MemoryRouter>,
  )
}

/** The tool group starts folded, so its chips are not on screen until it opens. */
function expandToolGroup() {
  fireEvent.click(screen.getByRole('button', { name: /show the work/i }))
  fireEvent.click(screen.getByRole('button', { name: /^1 tool$/i }))
}

describe('ChatMessages Agent cards', () => {
  it('opens a finished background sub-agent from its Agent card', () => {
    const onOpenSubagent = vi.fn()
    renderChat([
      {
        id: 'agent-launch',
        role: 'assistant',
        content: 'Used Agent',
        timestamp: 100,
        toolCall: 'Agent',
        meta: { agentId: 'agent-7' },
      },
      { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 101 },
    ], onOpenSubagent)
    expandToolGroup()

    const card = screen.getByRole('button', { name: /Agent sub-agent transcript/i })
    fireEvent.click(card)

    expect(onOpenSubagent).toHaveBeenCalledWith(
      { id: 'agent-7', description: null, agentType: null },
      card,
    )
  })

  it('leaves a tool row whose call carried no sub-agent id as plain text', () => {
    renderChat([
      { id: 'tool-read', role: 'assistant', content: 'Used Read', timestamp: 100, toolCall: 'Read' },
      { id: 'answer', role: 'assistant', content: 'Done.', timestamp: 101 },
    ], vi.fn())
    expandToolGroup()

    const group = screen.getByTestId('tool-group-list')
    expect(within(group).getByText('Read')).toBeTruthy()
    expect(within(group).queryByRole('button', { name: /transcript/i })).toBeNull()
  })
})
