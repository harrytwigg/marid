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

/** What the gateway said of each target, by the key of the link as written and then by its
 *  resolved key: a row is a link as written, and one with no model would never find the
 *  gateway's reading under the resolved key, which carries the model it would run. */
function readingsByKey(subject: FallbackChainSubject | undefined): Map<string, ResolvedFallbackLink> {
  const known = new Map<string, ResolvedFallbackLink>()
  for (const link of [subject?.primary, ...(subject?.effective ?? [])]) {
    if (!link) continue
    if (link.written) known.set(fallbackLinkKey(link.written), link)
    if (!known.has(link.key)) known.set(link.key, link)
  }
  return known
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
  const known = readingsByKey(subject)
  // The gateway's own target carries the default model, so its key is not the bare `self`'s: take it from the subject.
  const own = subject?.primary ?? known.get(fallbackLinkKey(self)) ?? plainResolved(self)
  const rest = links.map((link, i) => ({
    ...(known.get(fallbackLinkKey(link)) ?? plainResolved(link)),
    origin: origins?.[i] ?? "config",
  }))
  return [{ ...own, skip: undefined }, ...rest]
}
