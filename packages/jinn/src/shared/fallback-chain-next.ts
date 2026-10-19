import type { EngineHealthReading } from "./engine-health.js";
import { isLinkExhausted } from "./fallback-chain-health.js";
import type { FallbackSkipReason, ResolvedFallbackLink } from "./fallback-chain-wire.js";

/**
 * Which link a limit moves a session to next. Pure: a resolved chain, where the
 * run stands and a health reading go in, the chosen link and the links passed
 * over on the way come out. The runtime walks with it and the session API's
 * `fallback.chain.next` reports with it, so the two cannot disagree.
 */

/** Where a run stands on its chain: the index of the target the session is on, and every target tried so far (the own target included). */
export interface FallbackRunCursor {
  position: number;
  tried: readonly string[];
}

export interface NextFallbackLink {
  /** Index into the chain. */
  index: number;
  link: ResolvedFallbackLink;
  /** Links passed over between the cursor and `link`, with why. */
  skipped: Array<{ key: string; reason: FallbackSkipReason }>;
}

/**
 * Where the run stands on `links` now: the recorded position, or past the
 * furthest tried target when the chain was edited since and the position no
 * longer points at the target the session is on. Never moves backwards, so an
 * edit cannot send a run to a target it already tried.
 */
export function effectivePosition(links: readonly ResolvedFallbackLink[], run: FallbackRunCursor | undefined): number {
  if (!run) return 0;
  const tried = new Set(run.tried);
  const triedAt = links.reduce((furthest, link, index) => (tried.has(link.key) ? index : furthest), 0);
  const recorded = Number.isFinite(run.position) ? Math.trunc(run.position) : 0;
  return Math.min(Math.max(recorded, triedAt, 0), Math.max(links.length - 1, 0));
}

function scan(
  links: readonly ResolvedFallbackLink[],
  cursor: FallbackRunCursor,
  isSpent: (link: ResolvedFallbackLink) => boolean,
): NextFallbackLink | undefined {
  const tried = new Set(cursor.tried);
  const skipped: NextFallbackLink["skipped"] = [];
  for (let index = Math.max(cursor.position, 0) + 1; index < links.length; index++) {
    const link = links[index]!;
    const reason: FallbackSkipReason | undefined = tried.has(link.key) ? "tried" : link.skip ?? (isSpent(link) ? "exhausted" : undefined);
    if (reason === undefined) return { index, link, skipped };
    skipped.push({ key: link.key, reason });
  }
  return undefined;
}

/**
 * The first link after the cursor that has not been tried, is not ruled out for
 * this session and is not at its limit. When that finds nothing, a second pass
 * ignores health only: a record can order a chain but never empty one.
 */
export function nextFallbackLink(
  links: readonly ResolvedFallbackLink[],
  cursor: FallbackRunCursor,
  health: EngineHealthReading,
  now: Date = new Date(),
): NextFallbackLink | undefined {
  return scan(links, cursor, (link) => isLinkExhausted(health, link, now)) ?? scan(links, cursor, () => false);
}
