import { declaredAccountByKey } from "../shared/claude-accounts-config.js";
import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { exhaustedEngineReturnsAt, type EngineHealthReading } from "../shared/engine-health.js";
import { sessionFallbackChain } from "../shared/fallback-chain.js";
import { linkModelWritten } from "../shared/fallback-chain-links.js";
import { isLinkExhausted, linkHealthKey } from "../shared/fallback-chain-health.js";
import type { FallbackChainSource, ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import type { EngineName } from "../shared/models.js";
import type { Employee, JinnConfig, ModelRegistry, Session } from "../shared/types.js";
import type { SessionReroute } from "./engine-override-window.js";
import { targetOfLink } from "./fallback-run.js";

/**
 * Where a NEW session starts when the target it would run on is out of
 * allowance: the first link of its chain that may be used and is not out
 * itself. Ordering, never refusal: with nothing healthy in the chain the session
 * starts where it would have. The record it carries (`SessionReroute`) is the
 * override a mid-turn swap parks plus the run that starts at that link, so the
 * session goes back to its own target once the window passes, and the next
 * limit continues the walk from there.
 */

export interface RerouteArgs {
  config: JinnConfig;
  /** The employee the session is for, when it is one: its own chain applies. */
  employee?: Employee;
  /** The target the session would start on. */
  engine: string;
  model?: string | null;
  /** `available` is whether the caller can run the engine for this session. */
  registry: ModelRegistry;
  health: EngineHealthReading;
  scope: { scoped: boolean; remote: boolean };
  now?: Date;
}

export interface RerouteChoice {
  engine: EngineName;
  /** The model the chain names for the link; absent: the engine's own default. */
  model?: string;
  reroute: SessionReroute;
}

/** A stand-in for the session that does not exist yet, which is all the resolver reads of it. */
function prospectiveSession(args: RerouteArgs): Session {
  return { id: "", engine: args.engine, model: args.model ?? null, employee: args.employee?.name ?? null, transportMeta: null, fallbackTarget: null } as unknown as Session;
}

/** Whether the link is another Claude account than the session would run: from a Claude target, a different account; from any other, a profile the link names (an unprofiled Claude link runs as the employee's own account). */
function swapsAccount(own: ResolvedFallbackLink, link: ResolvedFallbackLink): boolean {
  if (link.engine !== "claude") return false;
  return own.engine === "claude" ? link.account !== own.account : link.profile !== undefined;
}

/** The account swap a link makes, when it is another Claude account than the session would run. */
function accountSwapOf(args: RerouteArgs, own: ResolvedFallbackLink, link: ResolvedFallbackLink): SessionReroute["account"] {
  if (!swapsAccount(own, link)) return undefined;
  const profile = link.account === DEFAULT_CLAUDE_ACCOUNT ? null : declaredAccountByKey(args.config, link.account)?.profile ?? null;
  return { original: accountForEmployee(args.employee, "claude"), substitute: link.account, configDir: profile?.dir ?? null };
}

/** The record the session carries: the way back, the link it is on, the run that starts there, and the account swap when the link is another Claude account. */
function rerouteRecord(args: RerouteArgs, found: { own: ResolvedFallbackLink; link: ResolvedFallbackLink; index: number; source: FallbackChainSource }): SessionReroute {
  const { engine, health } = args;
  const { own, link, index, source } = found;
  const now = args.now ?? new Date();
  const ownKey = linkHealthKey(own);
  const account = accountSwapOf(args, own, link);
  return {
    from: engine,
    model: args.model?.trim() || null,
    until: exhaustedEngineReturnsAt(health, health[ownKey] ? ownKey : own.engine, now),
    run: { source, position: index, tried: [own.key], startedAt: now.toISOString() },
    target: targetOfLink(link),
    ...(account ? { account } : {}),
  };
}

export function rerouteAtCreation(args: RerouteArgs): RerouteChoice | undefined {
  const { config, employee, health, scope, registry } = args;
  const now = args.now ?? new Date();
  const session = prospectiveSession(args);
  const { source, links } = sessionFallbackChain({ config, employee, session, registry, health, scope, now });
  const own = links[0]!;
  if (!isLinkExhausted(health, own, now)) return undefined;
  const index = links.findIndex((link, at) => at > 0 && link.skip === undefined && !isLinkExhausted(health, link, now));
  if (index < 1) return undefined;
  const link = links[index]!;
  // A model the entry wrote is the session's; one it inherits is the target left's, and means nothing on the link.
  const model = linkModelWritten(link) ? link.model : undefined;
  return { engine: link.engine as EngineName, ...(model === undefined ? {} : { model }), reroute: rerouteRecord(args, { own, link, index, source }) };
}
