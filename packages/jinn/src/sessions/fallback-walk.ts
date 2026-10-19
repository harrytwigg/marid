import { awaitEffortLevels } from "../shared/effort-wait.js";
import { UNSTATED_RESET_WINDOW_MS } from "../shared/engine-health.js";
import type { FallbackChainSource, FallbackHop, FallbackHopReason, ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import { logger } from "../shared/logger.js";
import { computeNextRetryDelayMs, rateLimitEngineLabel } from "../shared/rateLimit.js";
import type { EngineName } from "../shared/models.js";
import type { EngineResult, Session } from "../shared/types.js";
import { claudeLinkRefusal, linkFailure, noteLinkAuthFailure, recordLinkLimit, runLink } from "./fallback-link-run.js";
import { buildHop, chainExhaustedReason, hopLogLine, limitReason, type HopEnd } from "./fallback-hop.js";
import { metaOf, readFallbackRun, servedBy, targetOfLink, withHop, withRun, withServedBy, type FallbackRunState } from "./fallback-run.js";
import { abandonEngineSubstitution, beginEngineSubstitution, standingOverrideUntil, type EngineSubstitution } from "./engine-override.js";
import { chooseSubstituteOrReason, type SubstituteDecision } from "./rate-limit-substitute.js";
import type { RateLimitHandlerOpts } from "./rate-limit-contract.js";
import { getSession, nextEngineSessionFields, updateSessionForAttempt } from "./registry.js";
import { handoffPrompt, resumedPrompt } from "./rate-limit-hop-prompt.js";
import { spawnCwd } from "./session-cwd.js";
import type { RemoteTarget, SessionRemoteTarget } from "../shared/types.js";

/**
 * Branch A of the rate-limit handler: hand a limited turn along the session's
 * fallback chain until one target serves it or the chain runs out.
 *
 * Each pass moves to the next link (`rate-limit-substitute.ts` chooses it), runs
 * the turn there and reads the result. A limit on that link (or, on a fallback
 * link only, a model it does not serve or a profile that is signed out) records
 * the failure, adds the link to the run's tried set and goes round again, so a
 * chain of N links makes at most N hops in one turn and never visits a target
 * twice. See docs/fallback-chains.md.
 */

export interface WalkInput {
  opts: RateLimitHandlerOpts;
  remote: (RemoteTarget & { remoteHost: string }) | undefined;
  remoteTarget: SessionRemoteTarget;
  /** The target that returned the limit: where the walk starts from. */
  limited: { engine: string; account: string };
}

export type WalkOutcome =
  | { kind: "served"; result: EngineResult }
  | { kind: "cancelled" }
  /** Nothing served the turn: it waits on its own target. `reason` says why no one else did, `hop` is the record that the chain ran out. */
  | { kind: "unserved"; reason?: string; hop?: FallbackHop; walked: boolean };

/** The target that just failed, and how. */
interface Failure {
  end?: HopEnd;
  engine: string;
  account: string;
  reason: FallbackHopReason;
  resetsAt?: number;
}

interface Walk {
  input: WalkInput;
  metaBefore: Session["transportMeta"];
  runAtStart: FallbackRunState | undefined;
  tried: Set<string>;
  /** The chain index the next scan resumes after. */
  cursor: number;
  source: FallbackChainSource | undefined;
  /** Every hop decided in this walk, oldest first; the first `written` are on the session already. */
  hops: FallbackHop[];
  written: number;
  flipped: boolean;
  failure: Failure;
  triedLabels: string[];
  ownLabel: string;
  startedAt: string;
}

type Found = SubstituteDecision & { choice: NonNullable<SubstituteDecision["choice"]>; next: NonNullable<SubstituteDecision["next"]>; chain: NonNullable<SubstituteDecision["chain"]> };

const endOf = (link: ResolvedFallbackLink): HopEnd => ({ key: link.key, label: link.label });

/** The session row the choice reads: the turn's own snapshot, with the mode and target as they stand on the stored row (they may have changed while the turn ran). */
function sessionForChoice(w: Walk): Session {
  const { session } = w.input.opts;
  const live = getSession(session.id);
  if (w.flipped && live) return live;
  return live ? { ...session, fallbackMode: live.fallbackMode, fallbackTarget: live.fallbackTarget } : session;
}

function choose(w: Walk): SubstituteDecision {
  const { opts, remote, remoteTarget } = w.input;
  const run = w.source === undefined ? undefined : { position: w.cursor, tried: [...w.tried] };
  return chooseSubstituteOrReason({
    config: opts.config, engines: opts.engines, session: sessionForChoice(w), employee: opts.employee,
    account: w.failure.account, remote, remoteTarget, ...(run ? { run } : {}),
  });
}

/** What the first look at the chain tells the walk: where the session stands, and its own target. */
function adopt(w: Walk, decision: SubstituteDecision): void {
  const chain = decision.chain;
  if (!chain || w.source !== undefined) return;
  w.source = chain.source;
  w.cursor = decision.position ?? 0;
  w.ownLabel = chain.links[0]!.label;
  w.tried.add(chain.links[0]!.key);
  const here = chain.links[w.cursor]!;
  w.tried.add(here.key);
  w.failure.end = endOf(here);
  for (const key of w.runAtStart?.tried ?? []) w.tried.add(key);
}

function startWalk(input: WalkInput): Walk {
  const { session, originalResult, rateLimit } = input.opts;
  const metaBefore = (getSession(session.id) ?? session).transportMeta;
  return {
    input, metaBefore, runAtStart: readFallbackRun(metaOf({ transportMeta: metaBefore })), tried: new Set(), cursor: 0, source: undefined,
    hops: [], written: 0, flipped: false, triedLabels: [], ownLabel: "", startedAt: new Date().toISOString(),
    failure: { engine: input.limited.engine, account: input.limited.account, reason: limitReason(originalResult), resetsAt: rateLimit.resetsAt },
  };
}

export async function walkFallbackChain(input: WalkInput): Promise<WalkOutcome> {
  const w = startWalk(input);
  // The chain bounds the loop: every pass adds a link to the tried set.
  for (let pass = 0; pass < 64; pass++) {
    const decision = choose(w);
    adopt(w, decision);
    if (w.source === "session" && w.flipped) return await unserved(w, { ...decision, reason: sessionTargetLimited(w) });
    if (!decision.choice || !decision.next || !decision.chain) return await unserved(w, decision);
    const outcome = await moveOnto(w, decision as Found);
    if (outcome) return outcome;
  }
  return await unserved(w, {});
}

function sessionTargetLimited(w: Walk): string {
  const target = w.input.opts.session.fallbackTarget ?? getSession(w.input.opts.session.id)?.fallbackTarget;
  return target ? `the chosen fallback ${target.engine} (${target.model}) is limited too` : "the chosen fallback is limited too";
}

/** Move the turn onto the chosen link and run it there. Undefined: that link failed in a way that moves on, so the walk goes round again. */
async function moveOnto(w: Walk, found: Found): Promise<WalkOutcome | undefined> {
  const { link } = found.next;
  const hop = buildHop({
    at: new Date(), from: w.failure.end!, to: endOf(link), reason: w.failure.reason, resetsAt: w.failure.resetsAt, skipped: found.next.skipped,
  });
  w.hops.push(hop);
  logger.info(hopLogLine(w.input.opts.session.id, hop));
  const refusal = claudeLinkRefusal(w.input.opts, found.choice);
  if (refusal) {
    await w.input.opts.hooks.onFallbackStart?.(startInfo(w, found.choice, hop));
    failedOver(w, found, { reason: "auth", isLimit: false });
    return undefined;
  }
  return await launch(w, found, hop);
}

function startInfo(w: Walk, choice: Found["choice"], hop: FallbackHop) {
  const { resetsAt } = w.failure;
  const { resumeAt, until } = windowOf(resetsAt);
  return { resumeAt: resumeAt ?? null, until, substitute: choice.engine, ...(choice.model ? { model: choice.model } : {}), hop };
}

function windowOf(resetsAt: number | undefined): { resumeAt: Date | undefined; until: Date } {
  const { resumeAt } = computeNextRetryDelayMs(resetsAt);
  return { resumeAt, until: resumeAt ?? new Date(Date.now() + UNSTATED_RESET_WINDOW_MS) };
}

function labelOf(choice: Found["choice"]): string {
  const account = choice.accounts ? `the ${choice.accounts.substitute} Claude account` : rateLimitEngineLabel(choice.engine);
  return account + (choice.model ? ` (${choice.model})` : "");
}

/** Announce the hop, then flip the session onto the link: the run, the hops and the override go in one write. Undefined when the attempt fence was lost. */
async function flipOnto(w: Walk, found: Found, hop: FallbackHop): Promise<EngineSubstitution | undefined> {
  const { opts } = w.input;
  const { session, attemptToken, config, employee, hooks } = opts;
  const { choice, next, chain } = found;
  const { resumeAt, until } = windowOf(opts.rateLimit.resetsAt);
  const current = w.flipped ? (getSession(session.id) ?? session) : session;
  await hooks.onFallbackStart?.(startInfo(w, choice, hop));

  // A swap made while another stands keeps that swap's window, so the session stays on the substitute until then.
  const backAt = standingOverrideUntil(current) ?? resumeAt;
  const engineLabel = rateLimitEngineLabel(w.failure.engine);
  await awaitEffortLevels(config, choice.engine, current, employee);
  const run: FallbackRunState = { source: chain.source, position: next.index, tried: [...w.tried], startedAt: w.runAtStart?.startedAt ?? w.startedAt };
  const substitution = beginEngineSubstitution({
    session: current, attemptToken, config, employee, substitute: choice.engine, model: choice.model, accounts: choice.accounts, until, syncSince: new Date().toISOString(),
    lastError: backAt
      ? `${engineLabel} usage limit — using ${labelOf(choice)} until ${backAt.toISOString()}`
      : `${engineLabel} usage limit — using ${labelOf(choice)} temporarily`,
    target: targetOfLink(next.link),
    fallback: { run, hops: w.hops.slice(w.written) },
  });
  if (substitution) {
    w.written = w.hops.length;
    w.flipped = true;
  }
  return substitution;
}

/** The prompt the link is sent: what its thread missed when it has one, the conversation so far when it has not. */
function promptFor(w: Walk, substitution: EngineSubstitution): string {
  const { session, prompt } = w.input.opts;
  return substitution.resumeSessionId ? resumedPrompt(session.id, substitution.syncedThrough ?? session.createdAt, prompt) : handoffPrompt(session.id);
}

async function launch(w: Walk, found: Found, hop: FallbackHop): Promise<WalkOutcome | undefined> {
  const { opts, remote } = w.input;
  const { choice } = found;
  const cwd = spawnCwd(opts.session, Boolean(remote)); // a scoped session's stage directory, resolved before anything is flipped
  const substitution = await flipOnto(w, found, hop);
  if (!substitution) return { kind: "cancelled" };
  const result = await runLink({ walk: w.input, choice, engine: opts.engines.get(choice.engine)!, substitution, prompt: promptFor(w, substitution), cwd });
  const failure = linkFailure(result, choice.engine);
  if (!failure) return await served(w, found, substitution.model ?? substitution.engineConfig.model, result);
  await opts.hooks.onFallbackFailed?.(result);
  if (failure.reason === "auth" && result.error) noteLinkAuthFailure(opts, choice, result.error);
  failedOver(w, found, failure, result);
  return undefined;
}

/** The link failed in a way that moves the walk on: remember it, and hold a limit against its target. */
function failedOver(w: Walk, found: Found, failure: { reason: FallbackHopReason; resetsAt?: number; isLimit: boolean }, result?: EngineResult): void {
  const { link } = found.next;
  w.tried.add(link.key);
  w.triedLabels.push(link.label);
  w.cursor = found.next.index;
  w.failure = { end: endOf(link), engine: link.engine, account: link.account, reason: failure.reason, resetsAt: failure.resetsAt };
  if (failure.isLimit) recordLinkLimit(link, failure.resetsAt);
  if (result?.error) logger.info(`Session ${w.input.opts.session.id}: ${link.label} could not serve the turn (${failure.reason})`);
}

async function served(w: Walk, found: Found, model: string | undefined, result: EngineResult): Promise<WalkOutcome> {
  const { opts } = w.input;
  const { session, attemptToken, hooks } = opts;
  const live = getSession(session.id);
  if (live) {
    // The live row carries the override, so an account substitute's id lands in its own account's slot.
    const thread = result.sessionId ? nextEngineSessionFields(live, found.choice.engine, result.sessionId) : {};
    updateSessionForAttempt(session.id, attemptToken, { ...thread, transportMeta: withServedBy(metaOf(live), servedBy(found.next.link)) as never });
  }
  await hooks.onFallbackComplete?.(result, { engine: found.choice.engine as EngineName, model });
  return { kind: "served", result };
}

/** Nothing left to move to. A session that left its own target goes back to where this turn found it; the run's hops are kept either way. */
async function unserved(w: Walk, decision: SubstituteDecision): Promise<WalkOutcome> {
  const walked = decision.chain !== undefined;
  const tried = w.tried.size > 1;
  const reason = decision.reason ?? (walked && tried ? chainExhaustedReason(w.triedLabels, w.ownLabel) : undefined);
  const hop = walked && tried ? exhaustedHop(w, decision) : undefined;
  if (hop) {
    w.hops.push(hop);
    logger.info(hopLogLine(w.input.opts.session.id, hop));
  }
  if (!(await settleExhausted(w))) return { kind: "cancelled" };
  return { kind: "unserved", ...(reason ? { reason } : {}), ...(hop ? { hop } : {}), walked };
}

/** The hop that records the chain ran out: what was left after the cursor, and why none of it could be used. */
function exhaustedHop(w: Walk, decision: SubstituteDecision): FallbackHop {
  const left = (decision.chain?.links ?? []).slice(w.cursor + 1).flatMap((link) => {
    const reason = w.tried.has(link.key) ? "tried" as const : link.skip;
    return reason === undefined ? [] : [{ key: link.key, reason }];
  });
  return buildHop({ at: new Date(), from: w.failure.end!, to: null, reason: w.failure.reason, resetsAt: w.failure.resetsAt, skipped: left });
}

/** Write what the walk decided that is not on the session yet. False when the attempt fence was lost. */
async function settleExhausted(w: Walk): Promise<boolean> {
  const { session, attemptToken } = w.input.opts;
  if (w.flipped) {
    // Back where the turn began: the engine, thread and model it ran on, with the hops this walk made on top.
    let meta = w.hops.reduce(withHop, metaOf({ transportMeta: w.metaBefore }));
    if (w.runAtStart) meta = withRun(meta, { ...w.runAtStart, tried: [...w.tried] });
    return abandonEngineSubstitution(session, attemptToken, meta as Session["transportMeta"]);
  }
  const unwritten = w.hops.slice(w.written);
  if (unwritten.length === 0) return true;
  const ended = (current: Session) => {
    const meta = unwritten.reduce(withHop, metaOf(current));
    return (w.runAtStart ? withRun(meta, { ...w.runAtStart, tried: [...w.tried] }) : meta) as never;
  };
  return Boolean(updateSessionForAttempt(session.id, attemptToken, (current) => ({ transportMeta: ended(current) })));
}
