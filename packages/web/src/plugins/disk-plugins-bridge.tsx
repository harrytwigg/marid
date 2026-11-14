import { useEffect } from 'react'
import { GATEWAY_EVENTS } from '@hundredfold/gateway-events'
import { useGateway } from '@/hooks/use-gateway'
import { scanDiskPlugins } from './disk-plugins'

/**
 * Renders nothing; keeps the loaded plugins in step with `~/.hundredfold/plugins/`.
 *
 * The gateway watches the directory and emits `plugins:changed`, so a saved
 * edit reloads the plugin without a refresh. Every reconnect rescans as well,
 * because an event that fired while the socket was down is one nobody will
 * resend.
 */
export function DiskPluginsBridge() {
  const { connected, subscribe } = useGateway()

  useEffect(() => {
    // Runs on mount and on every connection flip. The scan guards itself, so
    // the two coinciding at boot is one pass, not two.
    void scanDiskPlugins()
  }, [connected])

  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event === GATEWAY_EVENTS.pluginsChanged) void scanDiskPlugins()
      }),
    [subscribe],
  )

  return null
}
