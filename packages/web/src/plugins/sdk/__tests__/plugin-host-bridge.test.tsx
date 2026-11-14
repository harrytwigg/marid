import { readFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@hundredfold/gateway-events'
import { host } from '../host'
import { clearHostBridge, registerHostNotificationSink } from '../host-bridge'
import { resetHostEvents } from '../host-events'
import { resetHostState } from '../host-state'
import { PluginHostBridge } from '../plugin-host-bridge'

/**
 * The bridge is the only thing that makes `host.state` and `host.onEvent`
 * anything other than empty in the running app, so what it wires up is worth a
 * test even though the wiring itself is thin.
 */

const gateway = vi.hoisted(() => {
  const listeners = new Set<GatewayEventListener>()
  return {
    value: {
      connected: false,
      subscribe: (fn: GatewayEventListener) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    emit: (frame: GatewayEvent) => listeners.forEach((fn) => fn(frame)),
  }
})

vi.mock('@/hooks/use-gateway', () => ({ useGateway: () => gateway.value }))

function mountAt(path: string) {
  const router = createMemoryRouter([{ path: '*', element: <PluginHostBridge /> }], {
    initialEntries: [path],
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  gateway.value.connected = false
  resetHostState()
  resetHostEvents()
  clearHostBridge()
})

afterEach(() => {
  vi.clearAllMocks()
})

it('publishes the gateway connection into host.state', () => {
  gateway.value.connected = true

  mountAt('/')

  expect(host.state.getSnapshot().gatewayStatus).toBe('connected')
})

it('publishes the URL-selected session into host.state', () => {
  mountAt('/?session=sess-1')

  expect(host.state.getSnapshot().activeSession).toBe('sess-1')
})

it('feeds gateway frames to host.onEvent subscribers', () => {
  const handler = vi.fn()
  host.onEvent('queue:updated', handler)
  const frame: GatewayEvent = {
    event: 'queue:updated',
    payload: { sessionId: 'sess-1', sessionKey: 'agent:main:main', depth: 0 },
  }

  mountAt('/')
  gateway.emit(frame)

  expect(handler).toHaveBeenCalledWith(frame)
})

/* A plugin backend has no DOM, so its `host.notify` arrives as a frame. The
 * bridge is the half that turns it back into a notification, and it must reach
 * the same sink the browser verb writes to — otherwise one plugin speaks with
 * two voices. */
it('delivers a backend notice into the same notification sink host.notify uses', () => {
  const sink = vi.fn()
  registerHostNotificationSink(sink)

  mountAt('/')
  gateway.emit({
    event: 'plugin:notice',
    payload: { pluginId: 'mailbox', message: '3 new messages', level: 'warning' },
  })

  expect(sink).toHaveBeenCalledWith({ title: '3 new messages', level: 'warning' })
})

it('leaves every other frame out of the notification sink', () => {
  const sink = vi.fn()
  registerHostNotificationSink(sink)

  mountAt('/')
  gateway.emit({ event: 'plugins:changed', payload: {} })

  expect(sink).not.toHaveBeenCalled()
})

it('does not statically import the plugin SDK barrel onto the first paint', () => {
  // Vitest runs from the package root, so this is the file the host ships as.
  const source = readFileSync('src/plugins/sdk/plugin-host-bridge.tsx', 'utf8')
  expect(source).not.toMatch(/\bimport\s+['"]@hundredfold\/plugin-sdk['"]/)
})

it('logs a notice it cannot show rather than throwing into the socket', () => {
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  mountAt('/')
  expect(() =>
    gateway.emit({
      event: 'plugin:notice',
      payload: { pluginId: 'mailbox', message: 'nobody is listening', level: 'info' },
    }),
  ).not.toThrow()

  expect(consoleWarn).toHaveBeenCalled()
  consoleWarn.mockRestore()
})
