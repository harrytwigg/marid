import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@hundredfold/gateway-events'
import { DiskPluginsBridge } from '../disk-plugins-bridge'

/**
 * The bridge is the only thing that ever calls the scan in the running app, so
 * which signals reach it is worth a test even though the wiring is thin.
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

const scanDiskPlugins = vi.fn()

vi.mock('@/hooks/use-gateway', () => ({ useGateway: () => gateway.value }))
vi.mock('../disk-plugins', () => ({ scanDiskPlugins: () => scanDiskPlugins() }))

beforeEach(() => {
  gateway.value.connected = false
  scanDiskPlugins.mockReset()
})

it('scans once on mount', () => {
  render(<DiskPluginsBridge />)

  expect(scanDiskPlugins).toHaveBeenCalledTimes(1)
})

it('rescans on a plugins:changed frame', () => {
  render(<DiskPluginsBridge />)
  scanDiskPlugins.mockClear()

  gateway.emit({ event: 'plugins:changed', payload: {} })

  expect(scanDiskPlugins).toHaveBeenCalledTimes(1)
})

it('ignores frames that are not about plugins', () => {
  render(<DiskPluginsBridge />)
  scanDiskPlugins.mockClear()

  gateway.emit({ event: 'session:started', payload: { sessionId: 'sess-1' } })

  expect(scanDiskPlugins).not.toHaveBeenCalled()
})

// An event that fired while the socket was down is one nobody resends, so the
// reconnect is the only chance to notice what changed in the meantime.
it('rescans when the gateway reconnects', () => {
  const { rerender } = render(<DiskPluginsBridge />)
  scanDiskPlugins.mockClear()

  gateway.value.connected = true
  rerender(<DiskPluginsBridge />)

  expect(scanDiskPlugins).toHaveBeenCalledTimes(1)
})
