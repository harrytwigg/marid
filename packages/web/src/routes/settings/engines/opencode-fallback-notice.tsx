import type { EngineRegistryEntry, InternalFallbackStatus } from "@/lib/engine-registry"

/** Where the host migration is written down. */
export const FALLBACK_MIGRATION_URL = "https://github.com/harrytwigg/marid/blob/main/docs/fallback-chains.md#migrating-a-host"

/**
 * opencode on a host that still runs a fallback plugin would switch models by
 * itself, on top of the chain, with the gateway none the wiser. Said on the
 * opencode card when the gateway reports it, with the way out: the migration, and
 * `jinn doctor`, which says where the plugin is. The paths themselves are the
 * operator's own and are not shown. Neutralised (the gateway runs opencode with it
 * off) there is nothing to act on, so no link; the sentence stays, because the
 * host's files still carry it.
 */
function noticeSentence(status: InternalFallbackStatus): string {
  if (status.neutralised) return "This host has an opencode fallback plugin installed. The gateway runs opencode with it off, so only the chain below falls back."
  const hosts = status.remote?.length ?? 0
  const where = hosts === 0 ? "" : `, here and on ${hosts === 1 ? "1 remote host" : `${hosts} remote hosts`}`
  return `opencode's own fallback plugin is installed${where}: it switches models by itself when a provider reaches its limit, on top of the chain below. `
}

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
      {noticeSentence(status)}
      {!status.neutralised && (
        <>
          <a href={FALLBACK_MIGRATION_URL} target="_blank" rel="noreferrer" className="underline">
            Move it into the chain
          </a>
          {", then run "}
          <code data-opencode-doctor>jinn doctor</code>
          {" to see where it is and confirm it is gone."}
        </>
      )}
    </p>
  )
}
