import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { AREAS } from '@/contrib/types'
import { contributeProbes, describeHostedArea } from '@/contrib/__tests__/hosted-area'
import { ChatSidebar } from '@/components/chat/chat-sidebar'

/* The chat sidebar hosts `home.widgets`. Jinn has no dashboard route:
 * `/` is Chat, so the home surface is this rail — the desktop list and, at
 * `variant="mobile"`, the phone's home screen. Widgets sit below the control
 * band and above the chats, so one never pushes search off the top. */

vi.mock('@/hooks/use-sessions', () => ({
  useSessions: () => ({ data: [], isLoading: false }),
  usePinnedSessions: () => ({ data: [] }),
  useSessionCounts: () => ({ data: { counts: {}, perGroup: 8 } }),
  useSessionSearch: () => ({ data: undefined }),
  useUpdateSession: () => ({ mutate: vi.fn() }),
  useDeleteSession: () => ({ mutateAsync: vi.fn() }),
  useStopSession: () => ({ mutate: vi.fn() }),
  useArchiveSession: () => ({ mutateAsync: vi.fn() }),
  useUnarchiveSession: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteSessions: () => ({ mutateAsync: vi.fn() }),
  useDuplicateSession: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-pins', () => ({
  usePins: () => ({ data: new Set<string>() }),
  useTogglePin: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: { getOrg: () => Promise.resolve({ employees: [] }), getEmployee: () => Promise.resolve({}) },
}))

vi.mock('@/routes/settings-provider', () => ({
  useSettings: () => ({ settings: { portalName: 'Jinn', employeeOverrides: {} } }),
}))

function renderSidebar(variant: 'desktop' | 'mobile') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ChatSidebar selectedId={null} onSelect={vi.fn()} onNewChat={vi.fn()} variant={variant} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describeHostedArea('the chat sidebar', {
  area: AREAS.homeWidgets,
  variant: 'pane',
  renderHost: async () => renderSidebar('desktop'),
  findHostContent: async () => screen.findByLabelText('Search chats', { selector: 'button' }),
})

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

it.each(['desktop', 'mobile'] as const)(
  'puts a contributed widget below the control band and above the chats (%s)',
  async (variant) => {
    dispose = contributeProbes(AREAS.homeWidgets, [{ id: 'widget' }])

    renderSidebar(variant)

    const contributed = await screen.findByTestId('probe-widget')
    const search = screen.getByLabelText('Search chats', { selector: 'button' })
    const list = document.querySelector('[data-chat-list-scroll]')!

    expect(search.compareDocumentPosition(contributed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(contributed.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  },
)
