import { sessionFallbackChain, type SessionFallbackChainOptions } from "../shared/fallback-chain.js";
import type {
  FallbackChainSource, FallbackHop, ResolvedFallbackLink, SessionFallbackChainView,
} from "../shared/fallback-chain-wire.js";

/**
 * A session's chain as `GET /api/sessions/:id` reports it (`fallback.chain`): the
 * resolved chain, and where the session is on it, read from what the runtime
 * persists in `transportMeta`:
 *
 * - `fallbackRun { source, position, tried, startedAt }`: present only while the
 *   session is off its own target;
 * - `fallbackHops`: the recorded moves, most recent first, at most 20;
 * - `fallbackServedBy { key, label, at }`: the target that served the latest turn.
 *
 * Persisted state is read defensively: a malformed field reads as absent.
 */

const MAX_HOPS = 20;

interface FallbackRunState {
  source: FallbackChainSource;
  position: number;
  tried: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseRun(value: unknown): FallbackRunState | undefined {
  const run = record(value);
  if (!run || typeof run.position !== "number" || !Number.isFinite(run.position) || !Array.isArray(run.tried)) return undefined;
  const tried = run.tried.filter((key): key is string => typeof key === "string");
  return { source: run.source as FallbackChainSource, position: run.position, tried };
}

function isHop(value: unknown): value is FallbackHop {
  const hop = record(value);
  return hop !== undefined && typeof hop.at === "string" && typeof hop.from === "string"
    && (typeof hop.to === "string" || hop.to === null) && typeof hop.reason === "string";
}

/** The link a limit would move to next: the first one not yet tried and not passed over, a healthy one before a spent one. */
function nextLink(links: readonly ResolvedFallbackLink[], tried: ReadonlySet<string>): string | null {
  const open = links.filter((link) => !tried.has(link.key) && link.skip === undefined);
  return (open.find((link) => link.health?.state !== "exhausted") ?? open[0])?.key ?? null;
}

export function sessionFallbackChainView(options: SessionFallbackChainOptions): SessionFallbackChainView {
  const { source, links } = sessionFallbackChain(options);
  const meta = record(options.session.transportMeta) ?? {};
  const run = parseRun(meta.fallbackRun);
  const tried = new Set([links[0].key, ...(run?.tried ?? [])]);
  const servedBy = record(meta.fallbackServedBy)?.key;
  return {
    source,
    links,
    position: run ? Math.min(Math.max(Math.trunc(run.position), 0), links.length - 1) : 0,
    servedBy: typeof servedBy === "string" ? servedBy : null,
    next: nextLink(links, tried),
    hops: (Array.isArray(meta.fallbackHops) ? meta.fallbackHops : []).filter(isHop).slice(0, MAX_HOPS),
  };
}
