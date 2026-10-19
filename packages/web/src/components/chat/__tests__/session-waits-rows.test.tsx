import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor, within } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import type { DelegatedSessionWait, HeartbeatWait } from '@/lib/session-waits'
import {
  MIN, PARENT, builder, child, getSessionWaits, iso, monitor, mount, openPopup, respond, reviewer, sessionRows,
} from './session-waits-fixtures'

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, getSessionWaits: vi.fn() } }
})

describe('the waiting-on popup rows', () => {
  beforeEach(() => { getSessionWaits().mockReset() })
  afterEach(() => vi.useRealTimers())

  it('lists a monitor and two delegated children with their employee, relation and state', async () => {
    getSessionWaits().mockResolvedValue(respond([builder, reviewer, monitor]))
    mount()
    const { popup } = await openPopup()

    const [first, second] = sessionRows(popup)
    expect(first.textContent).toContain('Alpha Builder')
    expect(first.textContent).toContain('Delegated task')
    expect(first.textContent).toContain('PLA-1 · Build the popup')
    expect(first.textContent).toContain('Running')
    expect(first.textContent).toContain('8m')
    // No display name: the slug, title-cased, as the bar does.
    expect(second.textContent).toContain('Alpha Reviewer')
    expect(second.textContent).toContain('Review')
    expect(second.textContent).toContain('Waiting')

    const monitorRow = within(popup).getByTestId('background-wait-row')
    expect(monitorRow.textContent).toContain('Watch the deploy log')
    expect(monitorRow.textContent).toContain('ERROR retrying upload (attempt 3)')
    expect(monitorRow.textContent).toContain('running for 12m')
    expect(monitorRow.textContent).toContain('timeout 30m')
    expect(within(monitorRow).getByText(monitor.command!).getAttribute('title')).toBe(monitor.command)
    expect(within(popup).getByRole('heading', { name: 'Waiting on' })).toBeTruthy()
  })

  it('shows a session without a Todo by its title, and a heartbeat and re-run by what they are', async () => {
    const spawned = child({ sessionId: 'child-c', relation: 'session', todo: null, title: 'Check the lockfile' })
    const heartbeat: HeartbeatWait = {
      kind: 'heartbeat', id: 'hb-1', message: 'Poll the build queue', everySeconds: 600,
      nextFireAt: new Date(Date.now() + 4 * MIN).toISOString(), fireCount: 2, maxFires: null,
    }
    getSessionWaits().mockResolvedValue(respond([
      spawned,
      { kind: 'process', id: 'p-1', description: 'Dev server', command: 'pnpm dev', agentType: null,
        startedAt: iso(2 * MIN), lastOutput: null, timeoutMs: null },
      { kind: 'subagent', id: 'sa-1', description: 'Survey the repo', command: null, agentType: 'Explore',
        startedAt: iso(MIN), lastOutput: null, timeoutMs: null },
      { kind: 'rerun', startedAt: null },
      heartbeat,
    ]))
    mount()
    const { popup } = await openPopup()

    expect(sessionRows(popup)[0].textContent).toContain('Check the lockfile')
    expect(sessionRows(popup)[0].textContent).toContain('Session')
    const rows = within(popup).getAllByTestId('background-wait-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['process', 'subagent', 'rerun', 'heartbeat'])
    expect(rows[0].textContent).toContain('pnpm dev')
    expect(rows[1].textContent).toContain('Explore')
    expect(rows[2].textContent).toContain('Background re-run')
    expect(rows[3].textContent).toContain('Poll the build queue')
    expect(rows[3].textContent).toContain('next in 4m, every 10m')
  })

  it('indents a grandchild under the row it reports to', async () => {
    const grandchild = child({
      sessionId: 'grand-1', reportsTo: 'child-a', employee: 'alpha-lead',
      employeeDisplayName: 'Alpha Lead', todo: null, title: 'Dig into the walk', relation: 'session',
    })
    getSessionWaits().mockResolvedValue(respond([builder, grandchild]))
    mount()
    const { popup } = await openPopup()

    const parentItem = sessionRows(popup)[0].closest('li')!
    const nested = within(parentItem).getAllByTestId('session-wait-row')
    expect(nested).toHaveLength(2)
    expect(nested[1].textContent).toContain('Alpha Lead')
    expect(nested[1].closest('li')!.style.paddingLeft).toBe('14px')
  })

  it('does not link a restricted row or one that has gone', async () => {
    const restricted = child({
      sessionId: 'child-r', restricted: true, employee: null, employeeDisplayName: null, title: null, todo: null,
    })
    getSessionWaits().mockResolvedValueOnce(respond([builder, restricted]))
    const { client, opener } = mount()
    const { user, popup } = await openPopup()

    const restrictedRow = sessionRows(popup)[1]
    expect(restrictedRow.textContent).toContain('In another department')
    expect(restrictedRow.tagName).not.toBe('BUTTON')
    await user.click(restrictedRow)
    expect(opener).not.toHaveBeenCalled()

    // child-a drops out of the next response while the popup is open.
    getSessionWaits().mockResolvedValue(respond([restricted]))
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.sessionWaits(PARENT) }) })

    await waitFor(() => expect(within(popup).getByText('No longer available')).toBeTruthy())
    expect(within(popup).queryByRole('button', { name: /Alpha Builder/ })).toBeNull()
    expect(within(popup).queryByText('Build the popup')).toBeNull()
    await user.click(within(popup).getByText('No longer available'))
    expect(opener).not.toHaveBeenCalled()
  })

  it('shows rows for sessions the viewer may not read, which all arrive with the id "hidden"', async () => {
    const hidden = (overrides: Partial<DelegatedSessionWait>) => child({
      sessionId: 'hidden', reportsTo: 'hidden', restricted: true, employee: null, employeeDisplayName: null,
      title: null, todo: null, ...overrides,
    })
    getSessionWaits().mockResolvedValueOnce(respond([
      builder,
      hidden({ reportsTo: PARENT, status: 'waiting' }),
      hidden({ status: 'running' }),
      hidden({ status: 'error', active: false, endedAt: iso(MIN + 5_000) }),
    ]))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client, opener } = mount()
    const { user, popup } = await openPopup()

    const rows = sessionRows(popup)
    expect(rows).toHaveLength(4)
    const restricted = within(popup).getAllByText('In another department')
    expect(restricted).toHaveLength(3)
    for (const row of rows.slice(1)) {
      expect(row.getAttribute('data-state')).toBe('restricted')
      await user.click(row)
    }
    expect(opener).not.toHaveBeenCalled()
    // Nothing nests under a "hidden" parent, and no two rows share a key.
    expect(rows.every((row) => row.closest('li')!.parentElement!.closest('li') === null)).toBe(true)
    expect(errors.mock.calls.filter(([message]) => String(message).includes('same key'))).toHaveLength(0)

    // Hidden rows leaving a response are not reported as a vanished session.
    getSessionWaits().mockResolvedValue(respond([builder]))
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.sessionWaits(PARENT) }) })
    await waitFor(() => expect(sessionRows(popup)).toHaveLength(1))
    expect(within(popup).queryByText('No longer available')).toBeNull()
    errors.mockRestore()
  })

  it('shows an active session at the top when the session it reports to is not in the list', async () => {
    const orphan = child({ sessionId: 'grand-9', reportsTo: 'ended-child', todo: null, title: 'Left running', relation: 'session' })
    getSessionWaits().mockResolvedValue(respond([builder, orphan]))
    mount()
    const { popup } = await openPopup()

    const rows = sessionRows(popup)
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('Left running')
    expect(rows[1].closest('li')!.style.paddingLeft).toBe('')
    expect(within(popup).getByRole('region', { name: 'Waiting on' }).contains(rows[1])).toBe(true)
  })

  it('shows a background re-run without a duration', async () => {
    getSessionWaits().mockResolvedValue(respond([{ kind: 'rerun', startedAt: null }]))
    mount()
    const { popup } = await openPopup()

    const row = within(popup).getByTestId('background-wait-row')
    expect(row.textContent).toContain('Background re-run')
    expect(row.textContent).not.toMatch(/running for|\d+[smh]\b/)
  })

  it.each([
    ['idle', 'Finished'],
    ['error', 'Failed'],
    ['interrupted', 'Stopped'],
  ] as const)('moves a child that ends as %s to "Finished since the last turn" as %s', async (status, label) => {
    getSessionWaits().mockResolvedValueOnce(respond([builder, reviewer]))
    const { client } = mount()
    const { popup } = await openPopup()
    expect(within(popup).queryByRole('heading', { name: /Finished since the last turn/ })).toBeNull()

    getSessionWaits().mockResolvedValue(respond([
      child({ ...builder, status, active: false, endedAt: iso(2 * MIN + 5_000) }),
      reviewer,
    ]))
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.sessionWaits(PARENT) }) })

    const finished = await within(popup).findByRole('region', { name: 'Finished since the last turn' })
    expect(finished.textContent).toContain(label)
    expect(finished.textContent).toContain('finished 2m ago')
    expect(within(popup).getByRole('region', { name: 'Waiting on' }).textContent).toContain('Waiting')
  })

  it('shows no duration rather than NaN when a start time cannot be read', async () => {
    getSessionWaits().mockResolvedValue(respond([child({ ...builder, since: 'not a date' })]))
    mount()
    const { popup } = await openPopup()
    expect(sessionRows(popup)[0].textContent).not.toContain('NaN')
  })

  it('marks an archived child', async () => {
    getSessionWaits().mockResolvedValue(respond([child({ ...builder, archived: true })]))
    mount()
    const { popup } = await openPopup()
    expect(sessionRows(popup)[0].textContent).toContain('Archived')
  })

  it('keeps the whole subtree together when a finished child still has a running child of its own', async () => {
    const done = child({ ...builder, status: 'idle', active: false, endedAt: iso(MIN) })
    const still = child({ sessionId: 'grand-1', reportsTo: 'child-a', todo: null, title: 'Still going', relation: 'session' })
    getSessionWaits().mockResolvedValue(respond([still, done]))
    mount()
    const { popup } = await openPopup()

    expect(within(popup).queryByRole('region', { name: 'Finished since the last turn' })).toBeNull()
    const waiting = within(popup).getByRole('region', { name: 'Waiting on' })
    expect(within(waiting).getAllByTestId('session-wait-row')).toHaveLength(2)
  })
})
