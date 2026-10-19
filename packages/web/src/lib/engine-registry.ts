// The `/api/engines` registry, apart from the client that fetches it: adding a
// field here should not mean touching the file every other call lives in.
// Re-exported from `lib/api` so the existing importers are unchanged.

export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  effortLevels: string[];
  contextWindow?: number;
  /** Model is in the engine's featured set — shown by default in the picker. */
  featured?: boolean;
}
/** Whether an engine can serve a turn right now, beside the installed
 *  availability the registry reports. Advisory: an engine with no reading is
 *  healthy, and a stale reading only reorders a chain, never refuses a turn. */
export interface EngineHealth {
  state: "ok" | "exhausted" | "degraded";
  /** ISO. The reopening the engine itself stated, verbatim. */
  until?: string;
  /** The binding quota window as telemetry names it (`5h`, `7d`), when it does. */
  window?: string;
  reason?: string;
  observedAt?: string;
}
/** opencode's own model switching (a rate-limit plugin on the host), reported by the
 *  gateway so the dashboard can say the host would fall back twice. */
export interface InternalFallbackStatus {
  detected: boolean;
  /** The gateway already runs opencode with the plugin switched off. */
  neutralised?: boolean;
}
export interface EngineRegistryEntry {
  name: string;
  available: boolean;
  defaultModel: string;
  effortMechanism: "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "opencode-variant" | "none";
  models: ModelInfo[];
  supportsPty?: boolean; // interactive PTY/CLI view (`/ws/pty`)
  health?: EngineHealth;
  /** opencode only; absent from a gateway that does not report it. */
  internalFallback?: InternalFallbackStatus;
}
export interface EnginesResponse {
  default: string;
  engines: Record<string, EngineRegistryEntry>;
}
