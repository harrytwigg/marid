import type { EngineHealth } from "@/lib/api"

/** One engine's block under `engines.` in config.yaml. */
export interface EngineSettings {
  bin?: string
  model?: string
  effortLevel?: string
  fallback?: string[]
  /** `<model this engine serves>: <model the stand-in serves>`, applied when a
   *  turn falls through the chain. Edited on the card by model-map-editor.tsx,
   *  and by hand in config.yaml; the two agree because both refuse an entry in
   *  the same words, off `@jinn/fallback-map-wire`. */
  fallbackModelMap?: Record<string, string>
}

/** The `engines` block. `default` names an engine; every other key is one. */
export interface EnginesConfig {
  default?: string
  claude?: EngineSettings
  codex?: EngineSettings
  grok?: EngineSettings
  [engine: string]: EngineSettings | string | undefined
}

/** The legacy pair this section replaces. Both are nulled on migration. */
export interface SessionsFallbackConfig {
  rateLimitStrategy?: "wait" | "fallback" | null
  fallbackEngine?: string | null
}

export function chainFor(engines: EnginesConfig | undefined, engine: string): string[] {
  const entry = engines?.[engine]
  return (typeof entry === "object" ? entry.fallback : undefined) ?? []
}

/** The model translations configured for one engine, as `[from, to]` pairs in
 *  the order config.yaml states them. An engine with no map has none. */
export function modelMapFor(engines: EnginesConfig | undefined, engine: string): [string, string][] {
  const entry = engines?.[engine]
  const map = typeof entry === "object" ? entry.fallbackModelMap : undefined
  return Object.entries(map ?? {})
}

/** Engines the add control may offer: never the card's own engine, never one
 *  the chain already holds. Both are rejected by the gateway's validator, so
 *  offering them would only produce a save that fails. */
export function addOptionsFor(registryEngines: string[], engine: string, chain: string[]): string[] {
  return registryEngines.filter((name) => name !== engine && !chain.includes(name))
}

export function removeFromChain(chain: string[], index: number): string[] {
  return chain.filter((_, i) => i !== index)
}

/** Move one entry, keeping every other entry's relative order. An index outside
 *  the chain returns it unchanged rather than dropping or duplicating an entry. */
export function moveInChain(chain: string[], from: number, to: number): string[] {
  if (from === to) return chain
  if (from < 0 || from >= chain.length || to < 0 || to >= chain.length) return chain
  const next = [...chain]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
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
    { path: ["engines", "claude", "fallback"], value: [fallbackEngine] },
    { path: ["sessions", "rateLimitStrategy"], value: null },
    { path: ["sessions", "fallbackEngine"], value: null },
  ]
}
