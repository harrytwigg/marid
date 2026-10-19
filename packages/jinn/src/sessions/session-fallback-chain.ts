import { sessionFallbackChain, type SessionFallbackChainOptions } from "../shared/fallback-chain.js";
import { effectivePosition, nextFallbackLink } from "../shared/fallback-chain-next.js";
import type { SessionFallbackChainView } from "../shared/fallback-chain-wire.js";
import { metaOf, readFallbackHops, readFallbackRun, sessionAtOwnTarget } from "./fallback-run.js";

/**
 * A session's chain as `GET /api/sessions/:id` reports it (`fallback.chain`): the
 * resolved chain, and where the session is on it, read from what the runtime
 * persists in `transportMeta` (`fallback-run.ts` says what and when):
 *
 * - `fallbackRun { source, position, tried, startedAt }`: present only while the
 *   session is off its own target;
 * - `fallbackHops`: the recorded moves, most recent first, at most 20;
 * - `fallbackServedBy { key, label, at }`: the target that served the latest turn.
 *
 * Persisted state is read defensively: a malformed field reads as absent. `next`
 * is what the runtime would pick (`nextFallbackLink`), so the two cannot disagree.
 */
/** The key of the target that served the latest turn, when the session records one. */
function servedKeyOf(meta: Record<string, unknown>): string | null {
  const served = meta.fallbackServedBy;
  const key = typeof served === "object" && served !== null ? (served as { key?: unknown }).key : undefined;
  return typeof key === "string" ? key : null;
}

export function sessionFallbackChainView(options: SessionFallbackChainOptions): SessionFallbackChainView {
  // A session standing on a stand-in has the chain of the target it was moved off: resolve against that.
  const { source, links } = sessionFallbackChain({ ...options, session: sessionAtOwnTarget(options.session) });
  const meta = metaOf(options.session);
  const run = readFallbackRun(meta);
  const position = effectivePosition(links, run);
  const tried = [...(run?.tried ?? []), links[0]!.key, links[position]!.key];
  const hops = readFallbackHops(meta);
  // A session waiting on its own target after the chain ran out has nothing next: the wait is what comes before any new run.
  const ranOut = hops[0]?.to === null && options.session.status === "waiting";
  return {
    source,
    links,
    position,
    servedBy: servedKeyOf(meta),
    next: ranOut ? null : nextFallbackLink(links, { position, tried }, options.health, options.now)?.link.key ?? null,
    hops,
  };
}
