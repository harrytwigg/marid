/**
 * The one way a browser verb reaches the gateway.
 *
 * Every verb is one request to an endpoint the dashboard already calls, over the
 * app's own `authFetch` — so a plugin inherits the operator's session and the
 * gateway's own authorization, and no route exists that serves plugins alone.
 * Each verb passes the permission gate first; that call is the seam, and a verb
 * that skipped it would be a verb no policy could ever refuse.
 */
import { authFetch } from '@/lib/auth'
import { PluginSdkError } from '../errors'
import { assertVerbAllowed, type PluginHostVerb } from '../host-permissions'

/** The gateway's own message when it refused, or the bare status when the body
 *  was not an error envelope. Either beats "request failed".
 *
 *  Two spellings, because the gateway has two: most routes answer `{ error }`,
 *  while some answer `{ code, message }`. Reading only the first would turn
 *  those refusals into a bare status line. */
async function failureOf(verb: PluginHostVerb, response: Response): Promise<PluginSdkError> {
  let detail = `${response.status} ${response.statusText}`.trim()
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown }
    const stated = typeof body.error === 'string' ? body.error : body.message
    if (typeof stated === 'string' && stated) detail = stated
  } catch {
    // A non-JSON error body leaves the status line, which is still true.
  }
  return new PluginSdkError(`[plugin-sdk] host.${verb} failed: ${detail}`)
}

export async function request<T>(
  verb: PluginHostVerb,
  path: string,
  init?: RequestInit,
): Promise<T> {
  assertVerbAllowed(verb)
  const response = await authFetch(path, init)
  if (!response.ok) throw await failureOf(verb, response)
  return (await response.json()) as T
}

export function write<T>(verb: PluginHostVerb, path: string, body: unknown): Promise<T> {
  return request<T>(verb, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
