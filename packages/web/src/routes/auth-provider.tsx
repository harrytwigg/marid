import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { RouteFailure } from "@/components/route-failure"
import { PairingScreen } from "@/components/auth/pairing-screen"
import { accountsApi, type PrincipalWire } from "@/lib/accounts-api"
import { queryClient } from "@/lib/query-client"
import { createMemberSource } from "@/lib/member-source"
import {
  setRequestSource,
  bootstrapLocalAuth,
  createPairingCode,
  getAuthState,
  listPairedDevices as fetchPairedDevices,
  logoutBrowser,
  pairBrowser,
  takeWorkspacePairingCode,
  type AuthState,
  type PairedDevice,
  type PairingCode,
  unpairDevice as requestUnpairDevice,
} from "@/lib/auth"

type AuthStatus = "checking" | "paired" | "pairing-required" | "pairing" | "failed"
type PairingMode = "code" | "token"
interface RefreshOptions {
  bootstrapLocal?: boolean
}

interface AuthContextValue {
  status: AuthStatus
  authState: AuthState | null
  /** Who the gateway says this browser is; null when nobody is signed in. */
  principal: PrincipalWire
  devices: PairedDevice[]
  error: string | null
  pair: (secret: string, mode?: PairingMode) => Promise<void>
  /** Email and password sign-in. Rejects with an `AccountsError` for the form to word. */
  signIn: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  unpairDevice: (deviceId: string) => Promise<void>
  refresh: (opts?: RefreshOptions) => Promise<void>
  refreshDevices: () => Promise<void>
  createPairingCode: () => Promise<PairingCode>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** For surfaces that also render outside the provider (a page test, the public invite page). */
export function useAuthOptional(): AuthContextValue | null {
  return useContext(AuthContext)
}

let appliedPrincipalKey: string | null = null
let sessionLost: (() => void) | null = null

/** A member's requests go through the member source; anyone else's go straight to the gateway.
 *  Whatever the cache held for the previous identity is dropped, so a sign-out and a sign-in as
 *  someone else in the same tab can never show the first person's boards. */
function applyPrincipal(principal: PrincipalWire): void {
  const key = principal?.kind === "member" ? `member:${principal.user.id}` : principal?.kind ?? "none"
  setRequestSource(principal?.kind === "member" ? createMemberSource(() => sessionLost?.()) : null)
  if (appliedPrincipalKey !== null && appliedPrincipalKey !== key) queryClient.clear()
  appliedPrincipalKey = key
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking")
  const [authState, setAuthState] = useState<AuthState | null>(null)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await fetchPairedDevices())
    } catch {
      setDevices([])
    }
  }, [])

  const refresh = useCallback(async (opts: RefreshOptions = {}) => {
    const shouldBootstrapLocal = opts.bootstrapLocal ?? true
    setStatus("checking")
    setError(null)
    try {
      let state = await getAuthState()
      // Always consume the fragment before rendering. A private loopback-backed
      // workspace may not need the credential, but it still must not linger in
      // the address bar after the cross-workspace handoff.
      const workspacePairingCode = takeWorkspacePairingCode()
      if (state.authRequired && !state.authenticated) {
        if (workspacePairingCode) {
          try {
            await pairBrowser(workspacePairingCode, "code")
            state = await getAuthState()
          } catch (err) {
            setError(err instanceof Error ? err.message : "The workspace launch code expired. Pair this browser manually.")
          }
        }
      }
      if (shouldBootstrapLocal && state.authRequired && !state.authenticated && state.canBootstrapLocal) {
        if (await bootstrapLocalAuth()) state = await getAuthState()
      }
      const member = state.principal?.kind === "member"
      applyPrincipal(state.principal ?? null)
      setAuthState(state)
      const paired = !state.authRequired || state.authenticated || member
      setStatus(paired ? "paired" : "pairing-required")
      // A member has no paired devices to list, and the route is the operator's.
      if (paired && state.authRequired && !member) await refreshDevices()
      else setDevices([])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check gateway access")
      setStatus("failed")
    }
  }, [refreshDevices])

  useEffect(() => {
    sessionLost = () => { void refresh({ bootstrapLocal: false }) }
    return () => { sessionLost = null }
  }, [refresh])

  useEffect(() => {
    let alive = true
    void (async () => {
      await refresh()
      if (!alive) return
    })()
    return () => {
      alive = false
    }
  }, [refresh])

  const pair = useCallback(async (secret: string, mode: PairingMode = "code") => {
    setStatus("pairing")
    setError(null)
    try {
      await pairBrowser(secret, mode)
      const state = await getAuthState()
      applyPrincipal(state.principal ?? null)
      setAuthState(state)
      const paired = !state.authRequired || state.authenticated
      if (paired && state.authRequired) await refreshDevices()
      else setDevices([])
      if (!paired) setError("Pairing did not complete. Create a new code and try again.")
      setStatus(paired ? "paired" : "pairing-required")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid or expired pairing code")
      setStatus("pairing-required")
    }
  }, [refreshDevices])

  const signIn = useCallback(async (email: string, password: string) => {
    await accountsApi.login(email.trim(), password)
    await refresh({ bootstrapLocal: false })
  }, [refresh])

  const logout = useCallback(async () => {
    await logoutBrowser()
    setDevices([])
    await refresh({ bootstrapLocal: false })
  }, [refresh])

  const unpairDevice = useCallback(async (deviceId: string) => {
    const wasCurrent = devices.some((device) => device.id === deviceId && device.current)
    await requestUnpairDevice(deviceId)
    if (wasCurrent) {
      setDevices([])
      await refresh({ bootstrapLocal: false })
      return
    }
    await refreshDevices()
  }, [devices, refresh, refreshDevices])

  const value = useMemo<AuthContextValue>(
    () => ({ status, authState, principal: authState?.principal ?? null, devices, error, pair, signIn, logout, unpairDevice, refresh, refreshDevices, createPairingCode }),
    [authState, devices, error, logout, pair, signIn, refresh, refreshDevices, status, unpairDevice],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>")
  return ctx
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, authState, error, pair, signIn } = useAuth()
  if (status === "paired") return <>{children}</>
  if (status === "failed") return <RouteFailure />
  if (status === "checking") {
    return (
      <div className="min-h-dvh bg-[var(--bg)] text-[var(--text-tertiary)] flex items-center justify-center text-[length:var(--text-footnote)]">
        Checking gateway access...
      </div>
    )
  }
  return (
    <PairingScreen
      authState={authState}
      pairing={status === "pairing"}
      error={error}
      onPair={(secret, mode) => { void pair(secret, mode) }}
      onSignIn={authState?.accountsEnabled === true && authState.hasAccounts === true ? signIn : undefined}
    />
  )
}
