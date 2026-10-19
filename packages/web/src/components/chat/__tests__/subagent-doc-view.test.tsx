import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DocView } from '../doc-view'
import { docViewTestId } from '../doc-view-test-id'
import { getSubagentTranscript, type SubagentTranscriptResponse } from '@/lib/subagent-transcript'

vi.mock('@/lib/subagent-transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/subagent-transcript')>()
  return { ...actual, getSubagentTranscript: vi.fn() }
})

const doc = { kind: 'subagent', subagent: { sessionId: 's1', agentId: 'ag1', description: 'Audit the files', agentType: 'general-purpose' } } as const

const show = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><DocView doc={doc} /></MemoryRouter>
  </QueryClientProvider>,
)

describe('a sub-agent tab’s body', () => {
  beforeEach(() => { vi.mocked(getSubagentTranscript).mockReset() })

  it('is the chat’s transcript view of that sub-agent, read-only, with no composer', async () => {
    const answer: SubagentTranscriptResponse = {
      sessionId: 's1', agentId: 'ag1', available: true, truncated: false, updatedAt: new Date(Date.now() - 60_000).toISOString(),
      entries: [{ kind: 'prompt', text: 'Audit the files.', at: null }, { kind: 'text', text: 'All clear.', at: null }],
    }
    vi.mocked(getSubagentTranscript).mockResolvedValue(answer)
    show()

    expect(await screen.findByText('Audit the files.')).toBeTruthy()
    expect(screen.getByText('All clear.')).toBeTruthy()
    expect(vi.mocked(getSubagentTranscript).mock.calls[0].slice(0, 2)).toEqual(['s1', 'ag1'])
    expect(screen.getByTestId('subagent-title').textContent).toBe('Audit the files')
    expect(screen.getByTestId('subagent-readonly')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says the transcript is not available when there is none', async () => {
    vi.mocked(getSubagentTranscript).mockResolvedValue({ sessionId: 's1', agentId: 'ag1', available: false, reason: 'not-found' })
    show()
    await waitFor(() => expect(screen.getByTestId('subagent-unavailable').textContent).toContain('Transcript not available'))
  })

  it('has its own test id as a pane view', () => {
    expect(docViewTestId(doc)).toBe('pane-subagent-view')
  })
})
