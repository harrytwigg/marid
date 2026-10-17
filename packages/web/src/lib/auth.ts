import { gatewayTransport } from "./gateway-transport"
import { hashKeyNames, requestHeaderName } from "./codename"

export interface AuthState {
  authRequired: boolean
  authenticated: boolean
  canBootstrapLocal: boolean
  networkExposed: boolean
  /** Instance name serving this page, so pairing hints can name `jinn -i <instance> pair`. */
  instance?: string
}

export interface PairingCode {
  code: string
  expiresAt: string
  ttlSeconds?: number
}

export interface PairedDevice {
  id: string
  name: string
  kind?: "local" | "remote" | "token"
  createdAt?: string
  lastSeenAt?: string
  lastIp?: string
  userAgent?: string
  current?: boolean
}

// The CLI that opens the browser may be a build from before a codename change, so a launch URL's
// fragment key is read under either spelling.
const LOCAL_BOOTSTRAP_HASH_KEYS = hashKeyNames("bootstrap")
const WORKSPACE_PAIRING_HASH_KEYS = hashKeyNames("pair")

function takeHashValue(keys: readonly string[]): string | undefined {
  if (typeof window === "undefined") return undefined
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""))
  const key = keys.find((candidate) => params.get(candidate)?.trim())
  const value = key === undefined ? undefined : params.get(key)?.trim()
  if (key === undefined || !value) return undefined
  params.delete(key)
  const nextHash = params.toString()
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`,
  )
  return value
}

function takeLocalBootstrapGrant(): string | undefined {
  return takeHashValue(LOCAL_BOOTSTRAP_HASH_KEYS)
}

/** Consume the short-lived pairing code returned by authenticated workspace
 * creation. URL fragments never reach the server or referrer, and are removed
 * before the code is exchanged for the new instance's HttpOnly cookie. */
export function takeWorkspacePairingCode(): string | undefined {
  return takeHashValue(WORKSPACE_PAIRING_HASH_KEYS)
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `API error: ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) message = String(body.error)
      else if (body?.message) message = String(body.message)
    } catch {
      /* keep fallback */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

let knownInstance: string | null = null

export function authUrl(path: string): string {
  return gatewayTransport().httpUrl(path)
}

export async function getAuthState(): Promise<AuthState> {
  const res = await gatewayTransport().request("/api/auth/state", { method: "GET" })
  const state = await jsonOrThrow<AuthState>(res)
  knownInstance = state.instance?.trim() || null
  return state
}

/** The instance name the gateway last reported, for the surfaces that have to
 *  name which Jinn they are on without waiting on a request. Null until the
 *  app's first auth-state read has landed. */
export function lastKnownInstance(): string | null {
  return knownInstance
}

export async function bootstrapLocalAuth(): Promise<boolean> {
  const grant = takeLocalBootstrapGrant()
  if (!grant) return false
  const res = await gatewayTransport().request("/api/auth/bootstrap", {
    method: "POST",
    headers: { [requestHeaderName("bootstrap-grant")]: grant },
  })
  await jsonOrThrow(res)
  return true
}

export async function pairBrowser(secret: string, mode: "code" | "token" = "code"): Promise<void> {
  const res = await gatewayTransport().request(
    "/api/auth/pair",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mode === "token" ? { token: secret } : { code: secret }),
    },
  )
  await jsonOrThrow(res)
}

export async function createPairingCode(): Promise<PairingCode> {
  const res = await gatewayTransport().request(
    "/api/auth/pairing-codes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  )
  return jsonOrThrow<PairingCode>(res)
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
  const res = await gatewayTransport().request("/api/auth/devices", { method: "GET" })
  const body = await jsonOrThrow<{ devices: PairedDevice[] }>(res)
  return body.devices
}

export async function unpairDevice(deviceId: string): Promise<void> {
  const res = await gatewayTransport().request(
    `/api/auth/devices/${encodeURIComponent(deviceId)}`,
    { method: "DELETE" },
  )
  await jsonOrThrow(res)
}

export async function logoutBrowser(): Promise<void> {
  const res = await gatewayTransport().request("/api/auth/logout", { method: "POST", body: "{}" })
  await jsonOrThrow(res)
}

function assertGatewayProfile(profileId: string): void {
  if (gatewayTransport().profile.id !== profileId) {
    throw new DOMException("The gateway changed during authentication", "AbortError")
  }
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const transport = gatewayTransport()
  const profileId = transport.profile.id
  const first = await transport.request(input, init)
  if (first.status !== 401) return first

  // A native profile switch can happen between the original 401 and the local
  // bootstrap flow. Never continue A's authentication attempt against B.
  assertGatewayProfile(profileId)

  let state: AuthState
  try {
    state = await getAuthState()
  } catch {
    return first
  }
  if (!state.authRequired || state.authenticated || !state.canBootstrapLocal) return first

  try {
    if (!await bootstrapLocalAuth()) return first
  } catch {
    return first
  }
  assertGatewayProfile(profileId)
  return transport.request(input, init)
}
