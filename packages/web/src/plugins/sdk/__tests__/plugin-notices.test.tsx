import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@jinn/gateway-events'
import { ClientProviders } from '@/routes/client-providers'
import { host } from '../host'
import { clearHostBridge, hostNotificationSink } from '../host-bridge'
import { resetHostEvents } from '../host-events'
import { resetHostState } from '../host-state'

/**
 * The surface is what makes the sink non-null in the running app. Without it
 * mounted, both halves of `host.notify` take their "nothing is listening"
 * branch and the operator sees a console line instead of the notice.
 *
 * So this drives the real `ClientProviders` rather than the two host components
 * side by side: what has to hold is that the shipped tree mounts the surface,
 * and a hand-built pair would stay green with the production lines deleted.
 */

const gateway = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  return {
    value: {
      connected: true,
      subscribe: (fn: GatewayEventListener) => {
        gateway.onSubscribe?.()
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    /** Set by the ordering test to look at the sink at the one moment that
     *  distinguishes the two mount orders. */
    onSubscribe: undefined as (() => void) | undefined,
    emit: (frame: GatewayEvent) => listeners.forEach((fn) => fn(frame)),
  }
})

/** Everything around the host, reduced to pass-throughs, exactly as
 *  `client-providers.test.tsx` does — none of it is what this test is about,
 *  and all of it wants a live gateway. */
const passThrough = vi.hoisted(() => ({ children }: { children: ReactNode }) => children)

vi.mock('@/routes/providers', () => ({ ThemeProvider: passThrough }))
vi.mock('@/routes/auth-provider', () => ({ AuthProvider: passThrough, AuthGate: passThrough }))
vi.mock('@/routes/settings-provider', () => ({
  SettingsProvider: passThrough,
  DocumentTitle: () => null,
  useSettings: () => ({ settings: { talkOrb: false } }),
}))
vi.mock('@/hooks/use-gateway', () => ({
  GatewayProvider: passThrough,
  useGateway: () => gateway.value,
}))
vi.mock('@/hooks/use-query-invalidation', () => ({ useQueryInvalidation: () => {} }))
vi.mock('@/components/brand-favicon', () => ({ BrandFavicon: () => null }))
vi.mock('@/components/talk/talk-orb-overlay', () => ({ TalkOrbOverlay: () => null }))
/** The disk loader subscribes to the same gateway, which would make "who
 *  subscribed" ambiguous below — and it reads the inventory over the network. */
vi.mock('@/plugins/disk-plugins-bridge', () => ({ DiskPluginsBridge: () => null }))

function mountDashboard() {
  const router = createMemoryRouter(
    [{ path: '*', element: <ClientProviders>{null}</ClientProviders> }],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  resetHostState()
  resetHostEvents()
  clearHostBridge()
  gateway.onSubscribe = undefined
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('registers itself as the sink, so a browser notice reaches the screen', () => {
  mountDashboard()

  act(() => host.notify('the mailbox is unreachable', 'error'))

  expect(screen.getByText('the mailbox is unreachable')).not.toBeNull()
})

/* The surface has to be mounted ahead of the bridge, not merely alongside it:
 * a frame that arrives on the socket the moment the bridge subscribes has
 * nowhere to land otherwise. Subscribing is the instant the two orders differ. */
it('registers the sink before the host bridge subscribes to the gateway', () => {
  let sinkAtSubscribe: ReturnType<typeof hostNotificationSink> = null
  gateway.onSubscribe = () => {
    sinkAtSubscribe = hostNotificationSink()
  }

  mountDashboard()

  expect(sinkAtSubscribe).not.toBeNull()
})

/* Acceptance criterion 8's browser half, end to end: a backend notice travels
 * as a gateway frame and comes out on the same surface the browser verb uses. */
it('shows a backend notice that arrived as a gateway frame', () => {
  mountDashboard()

  act(() =>
    gateway.emit({
      event: 'plugin:notice',
      payload: { pluginId: 'mailbox', message: '3 new messages', level: 'warning' },
    }),
  )

  expect(screen.getByText('3 new messages')).not.toBeNull()
})

it('takes a notice away when it is dismissed', async () => {
  const user = userEvent.setup()
  mountDashboard()
  act(() => host.notify('read me'))

  await user.click(screen.getByRole('button', { name: 'Dismiss' }))

  expect(screen.queryByText('read me')).toBeNull()
})

/* A notice nobody dismissed must not still be on screen an hour later — an
 * unattended dashboard is the normal case, not the exception. */
it('clears a notice once its reading time is up', () => {
  vi.useFakeTimers()
  mountDashboard()
  act(() => host.notify('transient'))

  act(() => void vi.advanceTimersByTime(6_000))

  expect(screen.queryByText('transient')).toBeNull()
})

/* The richer notice is the same surface, not a second one that happens to look
 * alike: two stacks would drift apart in placement, dismissal and cap, and the
 * operator would learn two of them. One container is what proves it. */
it('raises a titled notice and a plain one into the one stack', () => {
  mountDashboard()

  act(() => {
    host.notify('the mailbox is unreachable', 'error')
    host.notify({
      title: 'Import finished',
      description: '42 messages arrived while you were away.',
    })
  })

  const stacks = document.querySelectorAll('[data-plugin-notices]')
  expect(stacks).toHaveLength(1)
  expect(stacks[0]!.textContent).toContain('the mailbox is unreachable')
  expect(stacks[0]!.textContent).toContain('Import finished')
  expect(stacks[0]!.textContent).toContain('42 messages arrived while you were away.')
})

/* A watcher in a retry loop can call notify without limit. The stack is capped
 * so the newest is always readable and the app is never papered over. */
it('keeps only the newest few when a plugin floods it', () => {
  mountDashboard()

  act(() => {
    for (const message of ['first', 'second', 'third', 'fourth']) host.notify(message)
  })

  expect(screen.queryByText('first')).toBeNull()
  expect(screen.getByText('fourth')).not.toBeNull()
})
