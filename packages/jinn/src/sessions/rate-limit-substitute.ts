import { isBoardWalkTurn } from "../board-walk/started-sessions.js";
import type { ClaudeProfile } from "../shared/claude-profile.js";
import { engineHealthForTarget, readEngineHealth } from "../shared/engine-health.js";
import { effectivePosition, nextFallbackLink, type FallbackRunCursor, type NextFallbackLink } from "../shared/fallback-chain-next.js";
import type { EngineHealthReading } from "../shared/engine-health.js";
import type { EngineName } from "../shared/models.js";
import type { Employee, JinnConfig, RemoteTarget, Session, SessionRemoteTarget } from "../shared/types.js";
import { metaOf, readFallbackRun, sessionAtOwnTarget } from "./fallback-run.js";
import { chooseTargetSubstitute } from "./fallback-target.js";
import { isAutoResume } from "./session-fallback.js";
import { launchFor } from "./substitute-launch.js";
import { resolveSubstituteChain, type SubstituteChain } from "./substitute-chain.js";

/** What a rate-limited turn moves onto: an engine, the Claude profile it runs
 *  as there, and, for another Claude account, the swap the override records. */
export interface SubstituteChoice {
  engine: EngineName;
  /** The model to run, when the chain or the session's own fallback target names one; otherwise the substitute's own default. */
  model?: string;
  claudeProfile: ClaudeProfile;
  accounts?: { original: string; substitute: string; substituteConfigDir: string | null; fallbackModelMap?: Record<string, string> };
}

export interface ChooseSubstituteInput {
  config: JinnConfig;
  engines: { has(name: string): boolean };
  session: Session;
  employee: Employee | undefined;
  /** The account the limit was recorded on (rate-limit-account.ts). */
  account: string;
  remote: (RemoteTarget & { remoteHost: string }) | undefined;
  remoteTarget: SessionRemoteTarget;
  /** Where the walk stands when the caller is partway along it; else read from the session's `fallbackRun`. */
  run?: FallbackRunCursor;
}

/** What the choice came to: the substitute and where it sits on the chain, or why there is none. */
export interface SubstituteDecision {
  choice?: SubstituteChoice;
  /** Why a session with its own fallback target cannot use it. */
  reason?: string;
  chain?: SubstituteChain;
  /** The chain index of the target the session is on now: where a walk resumes from. */
  position?: number;
  /** The chain position of the choice, and the links passed over to reach it. */
  next?: NextFallbackLink;
}

/**
 * The substitute for a rate-limited turn, or undefined when it should wait for
 * its own reset (Branch B).
 *
 * - A board walk turn never changes engine or account (FR-076).
 * - Neither does a session whose fallback mode is `auto-resume`: it parks and resumes.
 * - A session with its own fallback target (`session.fallbackTarget`) takes exactly that, or waits.
 * - Any other session takes the next link of its resolved chain (shared/fallback-chain.ts):
 *   its employee's `fallback`, its account's, or its engine's. The first link after where its run
 *   stands that has not been tried, may be used here and is not at its limit; when none is, the
 *   first that may be used. A remote session's link is an engine that can also run on its host,
 *   a department-scoped session's a Claude account, and an undeclared named profile has no chain
 *   unless its employee writes one (FR-056).
 */
export function chooseSubstitute(input: ChooseSubstituteInput): SubstituteChoice | undefined {
  return chooseSubstituteOrReason(input).choice;
}

/** As `chooseSubstitute`, and when a session with its own fallback target cannot use it, why:
 *  it never falls back to the config's chain, so the turn waits and says so. */
export function chooseSubstituteOrReason(input: ChooseSubstituteInput): SubstituteDecision {
  if (isBoardWalkTurn(input.session)) return {};
  if (isAutoResume(input.config, input.session)) return {};
  // Health recorded about the gateway's own login says nothing about the host
  // this turn is going back to.
  const health = engineHealthForTarget(readEngineHealth(), input.remoteTarget);
  const chain = resolveSubstituteChain(input, health);
  return input.session.fallbackTarget ? targetDecision(chain, chooseTargetSubstitute(input, health), chainPosition(chain, input)) : chainDecision(input, chain, health);
}

/** Where the session stands on its chain now: the run's position, else (no run recorded) where its stand-in, if any, sits. */
function chainPosition(chain: SubstituteChain, input: ChooseSubstituteInput): number {
  const stored = readFallbackRun(metaOf(input.session));
  return input.run || stored ? effectivePosition(chain.links, input.run ?? stored) : standingPosition(chain, input);
}

/** The next link of the chain after where the session stands, as the walk takes it. */
function chainDecision(input: ChooseSubstituteInput, chain: SubstituteChain, health: EngineHealthReading): SubstituteDecision {
  const position = chainPosition(chain, input);
  const tried = [...(input.run?.tried ?? readFallbackRun(metaOf(input.session))?.tried ?? []), chain.links[0]!.key, chain.links[position]!.key];
  const next = nextFallbackLink(chain.links, { position, tried }, health);
  if (!next) return { chain, position };
  // Only a model the chain names is a choice; one it leaves to the stand-in is derived when the swap is made, as it always was.
  const model = chain.namedModel(next.link);
  return {
    chain,
    position,
    next,
    choice: { engine: next.link.engine as EngineName, ...(model === undefined ? {} : { model }), ...launchFor(input, chain.accountMode, next.link) },
  };
}

/**
 * Where a session stands on its chain when no run is recorded: on its own target,
 * unless a stand-in holds it (an override written before runs were recorded), in
 * which case the link that stand-in is. Not found (the chain was edited since)
 * reads as the own target, which the tried set still keeps from being revisited.
 */
function standingPosition(chain: SubstituteChain, input: ChooseSubstituteInput): number {
  if (sessionAtOwnTarget(input.session) === input.session) return 0;
  const { engine, model } = input.session;
  const at = chain.links.findIndex((link, index) => index > 0 && link.engine === engine
    && (engine !== "claude" || link.account === input.account) && (link.model === undefined || !model || link.model === model));
  return Math.max(at, 0);
}

/** The session's own target, as the walk records it: the chain's one link after the own target. */
function targetDecision(chain: SubstituteChain, decision: ReturnType<typeof chooseTargetSubstitute>, position: number): SubstituteDecision {
  if ("reason" in decision) return { reason: decision.reason, chain, position };
  const link = chain.links[1];
  return { chain, position, choice: decision.choice, ...(link ? { next: { index: 1, link, skipped: [] } } : {}) };
}
