/** How an engine conveys reasoning-effort to its CLI. A pure leaf: the web bundle imports it as `@jinn/effort-mechanism`. */
export type EffortMechanism = "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "opencode-variant" | "musecode-turn" | "none";
