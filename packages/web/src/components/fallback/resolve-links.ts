import {
  fallbackLinkKey,
  fallbackLinkLabel,
  type FallbackChainSubject,
  type FallbackLink,
  type ResolvedFallbackLink,
} from "@jinn/fallback-chain-wire"

/** A link with nothing the gateway said about it: what the diagram draws before a reading, or for an unsaved row. */
export function plainResolved(link: FallbackLink, origin: ResolvedFallbackLink["origin"] = "config"): ResolvedFallbackLink {
  return { ...link, key: fallbackLinkKey(link), account: link.engine, label: fallbackLinkLabel(link), origin }
}

/**
 * The own target and links as the diagram draws them: each link carries what the
 * gateway said of it (health, why it would be skipped) when `subject` knows that
 * target, so a row the operator has just added or edited, which the gateway has not
 * seen, still shows, plain.
 */
export function resolveForFlow(
  self: FallbackLink,
  links: FallbackLink[],
  subject: FallbackChainSubject | undefined,
  origins?: ("config" | "legacy")[],
): ResolvedFallbackLink[] {
  const known = new Map<string, ResolvedFallbackLink>()
  for (const link of [subject?.primary, ...(subject?.effective ?? [])]) if (link) known.set(link.key, link)
  // The gateway's own target carries the default model, so its key is not the bare `self`'s: take it from the subject.
  const own = subject?.primary ?? known.get(fallbackLinkKey(self)) ?? plainResolved(self)
  const rest = links.map((link, i) => ({
    ...(known.get(fallbackLinkKey(link)) ?? plainResolved(link)),
    origin: origins?.[i] ?? "config",
  }))
  return [{ ...own, skip: undefined }, ...rest]
}
