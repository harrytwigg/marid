import type { FallbackChainEntry } from "@jinn/fallback-chain-wire"
import type { EngineHealth } from "@/lib/api"
import { linksOfEntries } from "./chain-links"

/** One engine's block under `engines.` in config.yaml. */
export interface EngineSettings {
  bin?: string
  model?: string
  effortLevel?: string
  /** Freebuff only: how many of its processes may be alive at once. */
  maxConcurrent?: number
  /** The chain as written: object links, or the legacy string forms. */
  fallback?: FallbackChainEntry[]
  /** Claude only: the declared accounts, each with a chain of its own. */
  accounts?: Record<string, AccountSettings>
  /** `<model this engine serves>: <model the stand-in serves>`, applied when a
   *  turn falls through the chain. Edited on the card by model-map-editor.tsx,
   *  and by hand in config.yaml; the two agree because both refuse an entry in
   *  the same words, off `@jinn/fallback-map-wire`. */
  fallbackModelMap?: Record<string, string>
}

/** A declared Claude account under `engines.claude.accounts`. */
export interface AccountSettings {
  /** A directory on the gateway, or on `remoteHost` when that is set. */
  configDir?: string
  /** Set: the account is a login on that host, with no chain of its own (a remote employee's `fallback` names it). */
  remoteHost?: string
  remoteUser?: string
  fallback?: FallbackChainEntry[]
  [key: string]: unknown
}

/** The `engines` block. `default` names an engine; every other key is one. */
export interface EnginesConfig {
  default?: string
  claude?: EngineSettings
  codex?: EngineSettings
  grok?: EngineSettings
  freebuff?: EngineSettings
  [engine: string]: EngineSettings | string | undefined
}

/** The legacy pair this section replaces. Both are nulled on migration. */
export interface SessionsFallbackConfig {
  rateLimitStrategy?: "wait" | "fallback" | null
  fallbackEngine?: string | null
}

/** The entries an engine's block states for its chain, in the order written. */
export function chainEntriesFor(engines: EnginesConfig | undefined, engine: string): FallbackChainEntry[] {
  const entry = engines?.[engine]
  return (typeof entry === "object" ? entry.fallback : undefined) ?? []
}

/** The entries a declared Claude account states for its chain. */
export function accountEntriesFor(engines: EnginesConfig | undefined, account: string): FallbackChainEntry[] {
  return engines?.claude?.accounts?.[account]?.fallback ?? []
}

/** A declared Claude account on another host. */
export interface RemoteAccount {
  name: string
  /** `user@host`, or the bare host with no user: what a remote employee's own destination is matched against. */
  destination: string
  /** The profile directory on that host. */
  configDir: string
}

function remoteHostOf(settings: AccountSettings | undefined): string {
  return typeof settings?.remoteHost === "string" ? settings.remoteHost.trim() : ""
}

/** The declared LOCAL Claude account names, in the order config.yaml states them: the ones that have a chain, and the ones an engine or account chain is offered. */
export function accountNames(engines: EnginesConfig | undefined): string[] {
  return Object.entries(engines?.claude?.accounts ?? {}).filter(([, settings]) => !remoteHostOf(settings)).map(([name]) => name)
}

/** Every declared account name, local and remote: what a stored chain's `profile` is checked against (the gateway accepts a remote account in any chain and passes it over where it cannot run). */
export function allAccountNames(engines: EnginesConfig | undefined): string[] {
  return Object.keys(engines?.claude?.accounts ?? {})
}

/** The declared accounts on other hosts, in the order config.yaml states them. */
export function remoteAccounts(engines: EnginesConfig | undefined): RemoteAccount[] {
  return Object.entries(engines?.claude?.accounts ?? {}).flatMap(([name, settings]) => {
    const host = remoteHostOf(settings)
    if (!host) return []
    const user = typeof settings.remoteUser === "string" ? settings.remoteUser.trim() : ""
    return [{ name, destination: user ? `${user}@${host}` : host, configDir: settings.configDir ?? "" }]
  })
}

/**
 * The engines the model map carries a turn onto: those of the chain's links that
 * leave the model unnamed and sit on another engine. A link that names a model
 * ignores the map, and a link on the engine itself keeps the session's own model.
 */
export function substituteChainFor(engines: EnginesConfig | undefined, engine: string): string[] {
  return linksOfEntries(chainEntriesFor(engines, engine))
    .filter((link) => link.model === undefined && link.engine !== engine)
    .map((link) => link.engine)
}

/** The model translations configured for one engine, as `[from, to]` pairs in
 *  the order config.yaml states them. An engine with no map has none. */
export function modelMapFor(engines: EnginesConfig | undefined, engine: string): [string, string][] {
  const entry = engines?.[engine]
  const map = typeof entry === "object" ? entry.fallbackModelMap : undefined
  return Object.entries(map ?? {})
}

export type EngineHealthTone = "healthy" | "exhausted" | "degraded"

export interface EngineHealthDisplay {
  tone: EngineHealthTone
  label: string
}

/** How a health record reads on a card. No record at all means healthy: the
 *  reading is advisory, and an engine nobody has observed failing is fine. */
export function classifyEngineHealth(health: EngineHealth | undefined, now: number = Date.now()): EngineHealthDisplay {
  if (health?.state === "degraded") return { tone: "degraded", label: "Degraded" }
  if (health?.state !== "exhausted") return { tone: "healthy", label: "Healthy" }
  const limit = health.window ? windowLabel(health.window) : "Out of allowance"
  const wait = formatWait(health.until, now)
  return { tone: "exhausted", label: wait ? `${limit}, back ${wait}` : limit }
}

/** Which limit is binding, in the operator's words. Telemetry names the two that
 *  matter; anything else is the provider's own name and is shown as given. */
function windowLabel(window: string): string {
  if (window === "5h") return "5-hour limit"
  if (window === "7d") return "Weekly limit"
  return `${window} limit`
}

/** The wait until the stated reopening, or null when it is absent, is not a date,
 *  or has already passed — a misparsed record should read as "no time", not as
 *  "Invalid Date". A reopening days out is a duration or a date and never a bare
 *  clock time, which would read as this afternoon. */
function formatWait(until: string | undefined, now: number): string | null {
  if (!until) return null
  const at = new Date(until)
  if (Number.isNaN(at.getTime())) return null
  const mins = Math.round((at.getTime() - now) / 60_000)
  if (mins <= 0) return null
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `in ${hrs}h`
  const days = Math.round(hrs / 24)
  return days <= 7 ? `in ${days}d` : `on ${at.toLocaleDateString()}`
}

/** A path/value pair for the Settings page's `updateConfig`. */
export interface ConfigMutation {
  path: string[]
  value: unknown
}

/** The engine `sessions.rateLimitStrategy: "fallback"` maps Claude onto, or null
 *  when no legacy mapping is configured. */
export function legacyFallbackEngine(sessions: SessionsFallbackConfig | undefined): string | null {
  if (sessions?.rateLimitStrategy !== "fallback") return null
  return sessions.fallbackEngine ?? null
}

/** Migrating the legacy pair onto a real chain. The two legacy keys are set to
 *  null rather than dropped because the gateway's config merge keeps any key the
 *  PUT omits — only an explicit null deletes one. */
export function legacyMigrationMutations(fallbackEngine: string): ConfigMutation[] {
  return [
    { path: ["engines", "claude", "fallback"], value: [{ engine: fallbackEngine }] },
    { path: ["sessions", "rateLimitStrategy"], value: null },
    { path: ["sessions", "fallbackEngine"], value: null },
  ]
}
