import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { GATEWAY_EVENTS } from "@hundredfold/gateway-events"
import { useGateway } from "@/hooks/use-gateway"
import { authFetch } from "@/lib/auth"

/**
 * The `/settings/plugins` data lane.
 *
 * It talks to the gateway directly through `authFetch`, the way
 * `plugins/disk-plugins.ts` does, rather than through `lib/api.ts`: the plugin
 * inventory is not part of the app's own API surface, and the settings page is
 * the only caller.
 */

export type PluginKind = "client" | "client+server"
export type PluginStatus = "loaded" | "disabled" | "error"

/** One inventory row, as `GET /api/plugins` returns it. Disabled and broken
 *  plugins are in it too: both are states, not absences. */
export interface PluginInventoryRow {
  id: string
  name: string
  version: string
  kind: PluginKind
  status: PluginStatus
  /** Why it failed, when `status` is `"error"`. */
  error?: string
  /** Present only for a plugin the gateway has ever run a watcher for. */
  watcher?: { status: "running" | "stopped" | "error"; detail?: string; restarts: number }
}

export const PLUGIN_INVENTORY_KEY = ["plugin-inventory"] as const

async function post(path: string, body?: unknown): Promise<void> {
  const response = await authFetch(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (response.ok) return
  // The gateway's own wording is the useful half of a 403 or a 500 here, and it
  // is what the page shows the operator.
  const detail = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(detail?.error ?? `the gateway answered ${response.status}`)
}

export function usePluginInventory() {
  return useQuery({
    queryKey: PLUGIN_INVENTORY_KEY,
    queryFn: async (): Promise<PluginInventoryRow[]> => {
      const response = await authFetch("/api/plugins")
      if (!response.ok) throw new Error(`the gateway answered ${response.status}`)
      const body = (await response.json()) as { inventory?: PluginInventoryRow[] }
      return body.inventory ?? []
    },
  })
}

/** Re-read the inventory when the plugins directory changes under the page: a
 *  folder edited on disk changes this list without anyone touching the UI, and
 *  the gateway says so. */
export function useInventoryFollowsDisk(): void {
  const qc = useQueryClient()
  const { subscribe } = useGateway()
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event === GATEWAY_EVENTS.pluginsChanged) {
          void qc.invalidateQueries({ queryKey: PLUGIN_INVENTORY_KEY })
        }
      }),
    [subscribe, qc],
  )
}

/** Toggle one plugin, showing the new state immediately and rolling it back if
 *  the gateway refuses. */
export function useTogglePlugin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      post(`/api/plugins/${encodeURIComponent(id)}/enabled`, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: PLUGIN_INVENTORY_KEY })
      const previous = qc.getQueryData<PluginInventoryRow[]>(PLUGIN_INVENTORY_KEY)
      qc.setQueryData<PluginInventoryRow[]>(PLUGIN_INVENTORY_KEY, (rows) =>
        rows?.map((row) =>
          // An errored plugin keeps its status: enabling it does not fix it, and
          // showing it as loaded for a moment would say it did.
          row.id === id && row.status !== "error"
            ? { ...row, status: enabled ? "loaded" : "disabled" }
            : row,
        ),
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) qc.setQueryData(PLUGIN_INVENTORY_KEY, context.previous)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: PLUGIN_INVENTORY_KEY }),
  })
}

export function useRevealPlugin() {
  return useMutation({
    mutationFn: (id: string) => post(`/api/plugins/${encodeURIComponent(id)}/reveal`),
  })
}

export function useRescanPlugins() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => post("/api/plugins/rescan"),
    onSettled: () => void qc.invalidateQueries({ queryKey: PLUGIN_INVENTORY_KEY }),
  })
}
