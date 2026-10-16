import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BackgroundActivityStatus } from '../background-activity-status'
import { useSubagentView } from '../use-subagent-view'
import type { BackgroundTaskWait } from '@/lib/session-waits'
import { getSubagentTranscript, type SubagentEntry, type SubagentTranscriptResponse } from '@/lib/subagent-transcript'
import { PARENT, getSessionWaits, iso, monitor, respond } from './session-waits-fixtures'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionWaits: vi.fn() } }
})
vi.mock('@/lib/subagent-transcript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/subagent-transcript')>()
  return { ...actual, getSubagentTranscript: vi.fn() }
})

const getTranscript = () => vi.mocked(getSubagentTranscript)

const subagent: BackgroundTaskWait = {
  kind: 'subagent',
  id: 'a0123456789abcdef',
  description: 'Count the lines',
  command: null,
  agentType: 'general-purpose',
  startedAt: iso(90_000),
  lastOutput: null,
  timeoutMs: null,
}

const prompt: SubagentEntry = { kind: 'prompt', text: 'Read notes.txt and count its lines.', at: null }
const tool: SubagentEntry = { kind: 'tool', id: 't1', name: 'Bash', input: 'wc -l notes.txt', result: '1 notes.txt', isError: false, at: null }
const said: SubagentEntry = { kind: 'text', text: 'The file has **one** line.', at: null }

const transcript = (entries: SubagentEntry[], updatedAt = new Date().toISOString()): SubagentTranscriptResponse =>
  ({ sessionId: PARENT, agentId: subagent.id, available: true, entries, truncated: false, updatedAt })
const unavailable = (reason: 'not-found' | 'unreadable' | 'no-conversation'): SubagentTranscriptResponse =>
  ({ sessionId: PARENT, agentId: subagent.id, available: false, reason })

/** What the chat pane does: the status line, and the view its popup opens, held beside it. */
function Pane({ active, session = PARENT, onPaneEvent }: { active: boolean; session?: string; onPaneEvent?: (type: string) => void }) {
  const view = useSubagentView(session)
  const seen = (type: string) => () => onPaneEvent?.(type)
  return (
    <div
      onKeyDown={seen('keydown')} onMouseDown={seen('mousedown')} onDragEnter={seen('dragenter')}
      onDragOver={seen('dragover')} onDrop={seen('drop')} onClick={seen('click')}
    >
      <BackgroundActivityStatus
        activity={active ? { activeAgents: 1, subAgents: 1 } as never : null}
        delegatedActivity={active ? { activeSessions: 1, employees: ['alpha-builder'] } : null}
        sessionId={session}
        onOpenSubagent={view.open}
      />
      {view.node}
    </div>
  )
}

function mount(active = true, onPaneEvent?: (type: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (on: boolean, session = PARENT) => (
    <QueryClientProvider client={client}><MemoryRouter><Pane active={on} session={session} onPaneEvent={onPaneEvent} /></MemoryRouter></QueryClientProvider>
  )
  const view = render(tree(active))
  return { rerender: (on: boolean, session = PARENT) => view.rerender(tree(on, session)) }
}

async function openSubagentRow() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /working/i }))
  const popup = await screen.findByRole('dialog')
  const row = await within(popup).findByRole('button', { name: /Count the lines/ })
  await user.click(row)
  return user
}

describe('a background sub-agent row in the waiting-on popup', () => {
  beforeEach(() => {
    getSessionWaits().mockReset()
    getTranscript().mockReset()
    getSessionWaits().mockResolvedValue(respond([monitor, subagent]))
  })

  it('is a button only where there is a view to open, and a monitor never is', async () => {
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /working/i }))
    const popup = await screen.findByRole('dialog')
    const rows = await within(popup).findAllByTestId('background-wait-row')

    expect(rows.map((row) => [row.getAttribute('data-kind'), row.tagName])).toEqual([['monitor', 'DIV'], ['subagent', 'BUTTON']])
  })

  it('opens the sub-agent’s prompt, tool calls and answer, and closes the popup', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, tool, said]))
    mount()
    await openSubagentRow()

    const dialog = await screen.findByTestId('subagent-transcript-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('subagent-entry')).toHaveLength(3))
    expect(getTranscript().mock.calls[0].slice(0, 2)).toEqual([PARENT, subagent.id])
    expect(within(dialog).getByText('Count the lines')).toBeTruthy()
    expect(within(dialog).getByText(/Read notes.txt and count its lines/)).toBeTruthy()
    expect(within(dialog).getByText('wc -l notes.txt', { selector: 'span' })).toBeTruthy()
    expect(within(dialog).getByTestId('subagent-tool-result').textContent).toBe('1 notes.txt')
    expect(within(dialog).getByText('one')).toBeTruthy()
    // The popup went; only the view is a dialog now.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('reads again while it is open, and shows what the sub-agent has written since', async () => {
    getTranscript().mockResolvedValueOnce(transcript([prompt, { ...tool, result: null }]))
    getTranscript().mockResolvedValue(transcript([prompt, tool, said]))
    mount()
    await openSubagentRow()

    const dialog = await screen.findByTestId('subagent-transcript-dialog')
    await waitFor(() => expect(within(dialog).getAllByTestId('subagent-entry')).toHaveLength(2))
    expect(within(dialog).getByText('running…')).toBeTruthy()
    await waitFor(() => expect(within(dialog).getAllByTestId('subagent-entry')).toHaveLength(3), { timeout: 5000 })
    expect(within(dialog).queryByText('running…')).toBeNull()
    expect(within(dialog).getByTestId('subagent-activity').getAttribute('data-live')).toBe('true')
  })

  it.each([
    ['not-found', /has not written a transcript/],
    ['unreadable', /could not read it/],
    ['no-conversation', /no Claude conversation/],
  ] as const)('says the transcript is not available when it is %s', async (reason, why) => {
    getTranscript().mockResolvedValue(unavailable(reason))
    mount()
    await openSubagentRow()

    const note = await screen.findByTestId('subagent-unavailable')
    expect(note.textContent).toContain('Transcript not available')
    expect(note.textContent).toMatch(why)
    expect(screen.queryByTestId('subagent-transcript')).toBeNull()
  })

  it('says so when the read itself fails, without losing the view', async () => {
    getTranscript().mockRejectedValue(new Error('boom'))
    mount()
    await openSubagentRow()
    expect(await screen.findByText(/Could not load this sub-agent/)).toBeTruthy()
    expect(screen.getByTestId('subagent-transcript-dialog')).toBeTruthy()
  })

  it('stays open when the status line goes, and closes with its own button', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, said]))
    const { rerender } = mount()
    const user = await openSubagentRow()
    await screen.findByTestId('subagent-transcript')

    rerender(false)
    await waitFor(() => expect(screen.queryByTestId('background-activity-status')).toBeNull())
    expect(screen.getByTestId('subagent-transcript-dialog')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('subagent-transcript-dialog')).toBeNull())
  })

  it('marks a sub-agent that has gone quiet', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, said], iso(5 * 60_000)))
    mount()
    await openSubagentRow()
    const activity = await screen.findByTestId('subagent-activity')
    expect(activity.getAttribute('data-live')).toBe('false')
    expect(activity.textContent).toMatch(/Quiet for/)
  })

  it('does not come back when the chat shows another session and then this one again', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, said]))
    const { rerender } = mount()
    await openSubagentRow()
    await screen.findByTestId('subagent-transcript')

    rerender(true, 'other-session')
    await waitFor(() => expect(screen.queryByTestId('subagent-transcript-dialog')).toBeNull())
    rerender(true, PARENT)

    await waitFor(() => expect(screen.getByTestId('background-activity-status')).toBeTruthy())
    expect(screen.queryByTestId('subagent-transcript-dialog')).toBeNull()
  })

  it('keeps its clicks, keys and dropped files from the chat pane behind it', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, said]))
    const events: string[] = []
    mount(true, (type) => events.push(type))
    await openSubagentRow()
    const dialog = await screen.findByTestId('subagent-transcript-dialog')
    events.length = 0

    fireEvent.click(dialog)
    fireEvent.mouseDown(dialog)
    fireEvent.keyDown(dialog, { key: 'a' })
    fireEvent.dragEnter(dialog)
    fireEvent.dragOver(dialog)
    const drop = createEvent.drop(dialog)
    fireEvent(dialog, drop)

    expect(events).toEqual([])
    // The browser must not open the file in place of the page.
    expect(drop.defaultPrevented).toBe(true)
  })

  it('returns focus to the status line it was opened from, which the popup row it came from no longer is', async () => {
    getTranscript().mockResolvedValue(transcript([prompt, said]))
    mount()
    const user = await openSubagentRow()
    await screen.findByTestId('subagent-transcript')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByTestId('subagent-transcript-dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('background-activity-trigger')))
  })
})
