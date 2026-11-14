import type { FallbackChainSource, FallbackHop, ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import type { JsonObject, Session } from "../shared/types.js";

/**
 * What a session persists about its walk along a fallback chain, in
 * `transportMeta` (docs/fallback-chains.md):
 *
 * - `fallbackRun { source, position, tried, startedAt }`: present only while the
 *   session is off its own target, and cleared the moment it goes back (every
 *   revert: the window ending, a hand-back, a manual engine switch, an API
 *   reset, a dead conversation). `tried` holds link keys, the own target's first.
 * - `fallbackHops`: the moves made, newest first, at most {@link MAX_FALLBACK_HOPS}.
 *   They outlive the run.
 * - `fallbackServedBy { key, label, at }`: the target that served the latest turn.
 *
 * Read defensively: a malformed field reads as absent.
 */

export const MAX_FALLBACK_HOPS = 20;

export interface FallbackRunState {
  source: FallbackChainSource;
  /** Index into the resolved chain of the target the session is on. */
  position: number;
  /** Keys of the targets tried in this run, the session's own target first. */
  tried: string[];
  startedAt: string;
}

export interface FallbackServedBy {
  key: string;
  label: string;
  at: string;
}

type Meta = Record<string, unknown>;

function asRecord(value: unknown): Meta | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Meta : undefined;
}

/** The transport meta as a plain object, a copy that is safe to change. */
export function metaOf(session: Pick<Session, "transportMeta"> | undefined | null): Meta {
  return { ...(asRecord(session?.transportMeta) ?? {}) };
}

export function readFallbackRun(meta: Meta | null | undefined): FallbackRunState | undefined {
  const run = asRecord(meta?.fallbackRun);
  if (!run || typeof run.position !== "number" || !Number.isFinite(run.position) || !Array.isArray(run.tried)) return undefined;
  return {
    source: run.source as FallbackChainSource,
    position: Math.max(0, Math.trunc(run.position)),
    tried: run.tried.filter((key): key is string => typeof key === "string"),
    startedAt: typeof run.startedAt === "string" ? run.startedAt : new Date(0).toISOString(),
  };
}

export function readFallbackHops(meta: Meta | null | undefined): FallbackHop[] {
  const hops = Array.isArray(meta?.fallbackHops) ? meta.fallbackHops as unknown[] : [];
  return hops.filter((hop): hop is FallbackHop => {
    const record = asRecord(hop);
    return record !== undefined && typeof record.at === "string" && typeof record.from === "string"
      && (typeof record.to === "string" || record.to === null) && typeof record.reason === "string";
  });
}

/** The run after one hop: `failed` joins the tried targets and the position moves to where the session lands. */
export function advanceRun(
  run: FallbackRunState | undefined,
  hop: { source: FallbackChainSource; own: string; failed: string; position: number; now: Date },
): FallbackRunState {
  const tried = new Set([...(run?.tried ?? [hop.own]), hop.own, hop.failed]);
  return { source: run?.source ?? hop.source, position: hop.position, tried: [...tried], startedAt: run?.startedAt ?? hop.now.toISOString() };
}

/** The meta with the hop recorded, newest first, capped. */
export function withHop(meta: Meta, hop: FallbackHop): Meta {
  return { ...meta, fallbackHops: [hop, ...readFallbackHops(meta)].slice(0, MAX_FALLBACK_HOPS) };
}

export function withRun(meta: Meta, run: FallbackRunState): Meta {
  return { ...meta, fallbackRun: run };
}

/** The meta with the run ended and the hops left in place. */
export function withoutRun(meta: Meta): Meta {
  const { fallbackRun: _ended, ...rest } = meta;
  return rest;
}

/** A link as the override records the stand-in: its engine, declared profile and model. */
export function targetOfLink(link: Pick<ResolvedFallbackLink, "engine" | "profile" | "model">): { engine: string; profile?: string; model?: string } {
  return { engine: link.engine, ...(link.profile === undefined ? {} : { profile: link.profile }), ...(link.model === undefined ? {} : { model: link.model }) };
}

export function servedBy(link: Pick<ResolvedFallbackLink, "key" | "label">, now: Date = new Date()): FallbackServedBy {
  return { key: link.key, label: link.label, at: now.toISOString() };
}

export function withServedBy(meta: Meta, served: FallbackServedBy): Meta {
  return { ...meta, fallbackServedBy: served };
}

/**
 * The session as it reads at its own target: while a stand-in holds it, the
 * engine and pin it was moved off (the override record parks them), and none of
 * the override. A chain is the own target's chain whichever target is running
 * now, so it is resolved against this view.
 */
export function sessionAtOwnTarget(session: Session): Session {
  const meta = asRecord(session.transportMeta);
  const override = asRecord(meta?.engineOverride);
  if (!meta || !override || typeof override.originalEngine !== "string") return session;
  const { engineOverride: _standing, ...rest } = meta;
  const model = "originalModel" in override ? (typeof override.originalModel === "string" ? override.originalModel : null) : session.model;
  return { ...session, engine: override.originalEngine, model, transportMeta: rest as JsonObject };
}
