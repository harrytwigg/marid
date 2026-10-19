import type { EngineRegistryEntry } from "@/lib/api"

/** Where the host migration is written down. */
export const FALLBACK_MIGRATION_URL = "https://github.com/harrytwigg/marid/blob/main/docs/fallback-chains.md#migrating-a-host"

/**
 * opencode on a host that still runs a fallback plugin would switch models by
 * itself, on top of the chain, with the gateway none the wiser. Said on the
 * opencode card when the gateway reports it. Neutralised, the gateway has already
 * turned the plugin off for its own runs, so there is nothing to act on and no
 * link; the sentence stays, because the host's files still carry it.
 */
export function OpencodeFallbackNotice({ entry }: { entry: EngineRegistryEntry }) {
  const status = entry.internalFallback
  if (entry.name !== "opencode" || !status?.detected) return null
  return (
    <p
      data-opencode-internal-fallback={status.neutralised ? "neutralised" : "active"}
      role="status"
      className="mt-[var(--space-2)] rounded-[10px] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]"
      style={{ background: "color-mix(in srgb, var(--system-orange) 12%, transparent)" }}
    >
      {status.neutralised
        ? "This host has an opencode fallback plugin installed. The gateway runs opencode with it off, so only the chain below falls back."
        : "This host's opencode switches models by itself when a provider reaches its limit, on top of the chain below. "}
      {!status.neutralised && (
        <a href={FALLBACK_MIGRATION_URL} target="_blank" rel="noreferrer" className="underline">
          Move it into the chain
        </a>
      )}
    </p>
  )
}
