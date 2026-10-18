/**
 * Human-facing names for engine keys.
 *
 * Kept in step with the gateway's rate-limit labels
 * (`packages/jinn/src/shared/rateLimit.ts`), which is where "opencode" is
 * lowercase on purpose (it is how the project spells its own name) and where
 * "musecode" is the two words "Muse Code". Anything unmapped falls back to a
 * title-cased key, so a new engine reads sanely before it is added here.
 */
const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
  musecode: "Muse Code",
  opencode: "opencode",
}

/** Display name for an engine key, e.g. `musecode` → "Muse Code". */
export function engineDisplayName(engine: string): string {
  const key = engine.trim().toLowerCase()
  return ENGINE_DISPLAY_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : engine)
}
