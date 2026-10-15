import { expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BackgroundActivityStatus } from '../background-activity-status'
import { SessionOpenContext } from '../file-open-context'
import { api } from '@/lib/api'
import type {
  BackgroundTaskWait,
  DelegatedSessionWait,
  SessionWaitItem,
  SessionWaitsResponse,
} from '@/lib/session-waits'

/** The mocked fetcher; each test file mocks `@/lib/api` itself. */
export const getSessionWaits = () => vi.mocked(api.getSessionWaits)

export const PARENT = 'parent-1'
export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
export const MIN = 60_000

export const monitor: BackgroundTaskWait = {
  kind: 'monitor',
  id: 'task-1',
  description: 'Watch the deploy log',
  command: 'tail -f /var/log/deploy.log | grep --line-buffered ERROR',
  agentType: null,
  startedAt: iso(12 * MIN),
  lastOutput: { line: 'ERROR retrying upload (attempt 3)', at: iso(5_000) },
  timeoutMs: 30 * MIN,
}

export function child(overrides: Partial<DelegatedSessionWait> & { sessionId: string }): DelegatedSessionWait {
  return {
    kind: 'session',
    reportsTo: PARENT,
    relation: 'delegated',
    restricted: false,
    employee: 'alpha-builder',
    employeeDisplayName: 'Alpha Builder',
    title: null,
    todo: { id: 'PLA-1', title: 'Build the popup' },
    status: 'running',
    active: true,
    since: iso(8 * MIN),
    endedAt: null,
    archived: false,
    ...overrides,
  }
}

export const builder = child({ sessionId: 'child-a' })
export const reviewer = child({
  sessionId: 'child-b',
  relation: 'review',
  employee: 'alpha-reviewer',
  employeeDisplayName: null,
  todo: { id: 'PLA-1', title: 'Build the popup' },
  status: 'waiting',
  since: iso(3 * MIN),
})

export function respond(items: SessionWaitItem[]): SessionWaitsResponse {
  return { sessionId: PARENT, generatedAt: new Date().toISOString(), items }
}

export const ACTIVE = { activeSessions: 2, employees: ['alpha-builder', 'alpha-reviewer'] }

export function Harness({ opener, onBarClick, active = true }: {
  opener: (id: string) => void
  onBarClick?: () => void
  active?: boolean
}) {
  return (
    <SessionOpenContext.Provider value={opener}>
      <div onClick={onBarClick}>
        <BackgroundActivityStatus
          activity={null}
          delegatedActivity={active ? ACTIVE : null}
          sessionId={PARENT}
        />
      </div>
    </SessionOpenContext.Provider>
  )
}

export function mount(props: Partial<Parameters<typeof Harness>[0]> = {}): { client: QueryClient; opener: (id: string) => void; view: RenderResult } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const opener = props.opener ?? vi.fn()
  const view = render(
    <QueryClientProvider client={client}><MemoryRouter><Harness {...props} opener={opener} /></MemoryRouter></QueryClientProvider>,
  )
  return { client, opener, view }
}

export async function openPopup() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /working|employees/i }))
  const popup = await screen.findByRole('dialog')
  // The popup's code loads on first open (empty until it has), then its first answer.
  await waitFor(() => expect(popup.textContent).not.toMatch(/^(Loading…)?$/))
  return { user, popup }
}

export const sessionRows = (popup: HTMLElement) => within(popup).getAllByTestId('session-wait-row')
