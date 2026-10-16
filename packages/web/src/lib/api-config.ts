import { authFetch } from "@/lib/auth"
import { readResponseHeader, requestHeaderName } from "@/lib/codename"

/**
 * The name the gateway stamps config.yaml's revision under, on both the GET that
 * serves the document and the PUT that rewrites it. Spelled here rather than
 * imported: the gateway's own module reaches node:fs to compute the value, and
 * nothing runtime crosses from that package into the bundle. `X-Jinn-Origin` is
 * duplicated the same way, for the same reason. The gateway answers under both codenames'
 * spellings while a rename is in effect, so a page reads either and sends the current one.
 */
export const CONFIG_REVISION_HEADER = requestHeaderName("config-revision")

/** config.yaml, and which config.yaml it was. */
export interface ConfigDocument {
  config: Record<string, unknown>
  /** Opaque. Hand it back to `updateConfig` and a save that would overwrite
   *  somebody else's hand edit is refused instead of landing. */
  revision: string
}

/** What a save leaves behind: the revision the file now has, so the page that
 *  just wrote it is current again rather than stale against its own write. */
export interface ConfigSaveResult {
  revision: string
}

/**
 * Turning a failed response into the thrown error, passed in rather than
 * imported so this module stays a leaf: `api.ts` depends on it, never the reverse.
 */
export interface ConfigHttp {
  responseError: (res: Response) => Promise<Error>
}

/** The config slice of the `api` object, spread back in at its old position. */
export function createConfigApi({ responseError }: ConfigHttp) {
  return {
    getConfig: async (): Promise<ConfigDocument> => {
      const res = await authFetch("/api/config")
      if (!res.ok) throw await responseError(res)
      return { config: await res.json(), revision: readResponseHeader(res.headers, "config-revision") ?? "" }
    },
    /** `revision` is the one `getConfig()` handed over. Sending it is what lets the
     *  gateway refuse a save that would overwrite an edit made since; omitting it is
     *  how a partial write that never read the whole document opts out. */
    updateConfig: async (data: Record<string, unknown>, revision?: string): Promise<ConfigSaveResult> => {
      const res = await authFetch("/api/config", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(revision ? { [CONFIG_REVISION_HEADER]: revision } : {}),
        },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw await responseError(res)
      return { revision: readResponseHeader(res.headers, "config-revision") ?? "" }
    },
  }
}
