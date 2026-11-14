import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import type { GatewayEvent } from '@hundredfold/gateway-events'
import { parseSelectedSession } from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { hostNotificationSink } from './host-bridge'
import { dispatchHostEvent } from './host-events'
import { publishHostState } from './host-state'
// The `@hundredfold/plugin-sdk` barrel is named from `installPluginSdk()` as a
// dynamic import, not here. A static import put Select/Menu and the floating
// layer back on every dashboard's first paint.

/**
 * A plugin backend's `host.notify` arrives as a frame, because a backend has no
 * DOM to raise a toast from. It lands in the same sink the browser verb writes
 * to, so both halves of one plugin speak through one notification surface
 * rather than two that look different.
 */
function deliverPluginNotice(frame: GatewayEvent): void {
  if (frame.event !== 'plugin:notice') return
  const sink = hostNotificationSink()
  const { pluginId, message, level } = frame.payload
  if (!sink) {
    console.warn(`[plugin-sdk] no notification surface is mounted; dropping ${level} from ${pluginId}: ${message}`)
    return
  }
  try {
    sink({ title: message, level })
  } catch (error) {
    console.error(`[plugin-sdk] the notification surface threw on ${level} from ${pluginId}: ${message}`, error)
  }
}

/**
 * Renders nothing; keeps the host's readonly state and its event fan-out fed
 * from the app's own single sources — the one gateway socket and the URL.
 * A second socket, or a second definition of "the open session", is how the
 * host's answer and the app's answer drift apart.
 */
export function PluginHostBridge() {
  const { connected, subscribe } = useGateway()
  const { search } = useLocation()

  useEffect(() => {
    publishHostState({ gatewayStatus: connected ? 'connected' : 'disconnected' })
  }, [connected])

  useEffect(() => {
    publishHostState({ activeSession: parseSelectedSession(search) })
  }, [search])

  useEffect(
    () =>
      subscribe((frame) => {
        dispatchHostEvent(frame)
        deliverPluginNotice(frame)
      }),
    [subscribe],
  )

  return null
}
