/**
 * Human-facing names for engine keys.
 *
 * The gateway has the same idea for rate-limit state in
 * `packages/jinn/src/shared/rateLimit.ts` (`RATE_LIMIT_ENGINE_LABELS`), and that
 * is where "opencode" is lowercase on purpose — it is how the project spells its
 * own name. It is not literally the same map: the gateway's also carries pi and
 * hermes. Anything unmapped falls back to a title-cased key, so a new engine
 * reads sanely before it is added here.
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
