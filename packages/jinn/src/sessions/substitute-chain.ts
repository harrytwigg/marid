import { accountForEmployee, DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import type { EngineHealthReading } from "../shared/engine-health.js";
import { sessionFallbackChain } from "../shared/fallback-chain.js";
import { linkModelWritten } from "../shared/fallback-chain-links.js";
import type { FallbackChainSource, ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import { engineAvailable, engineSupportsRemote, getModelRegistry, type EngineName } from "../shared/models.js";
import { sshDestination } from "../shared/remote-target.js";
import type { ModelRegistry } from "../shared/types.js";
import type { RemoteEngineName } from "../shared/models.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import type { ChooseSubstituteInput } from "./rate-limit-substitute.js";
import { availabilityRegistry } from "./availability-registry.js";
import { sessionAtOwnTarget } from "./fallback-run.js";
import { substituteScoped } from "./substitute-filters.js";

/**
 * A session's chain as a rate-limited turn walks it: the resolver's chain for
 * the session's OWN target (a session standing on a stand-in has the chain of
 * the target it was moved off), with what only the runtime knows put in:
 *
 * - which engines are installed and registered, on this host or the remote one;
 * - health, read for the host the turn runs on;
 * - an unprofiled Claude link reached from another engine runs on the
 *   employee's own Claude account, as it always has, so it is judged there.
 */

export interface SubstituteChain {
  source: FallbackChainSource;
  /** Index 0 is the session's own target. */
  links: ResolvedFallbackLink[];
  /** The chain's expansion mode: a local Claude session walks accounts, any other session engines. */
  accountMode: boolean;
  /** The model a link's entry wrote, as opposed to the one it inherits from the session or the engine's `fallbackModelMap` (which a swap derives itself). */
  namedModel: (link: ResolvedFallbackLink) => string | undefined;
}

/** The registry the resolver reads, with `available` meaning what the walk always meant by it: registered with this gateway and installed where the turn runs. */
function runtimeRegistry(input: ChooseSubstituteInput): ModelRegistry {
  const { config, engines, remote } = input;
  return availabilityRegistry(getModelRegistry(config), (name) => {
    const installed = remote && engineSupportsRemote(name as EngineName)
      ? remoteEngineAvailable(sshDestination(remote), name as RemoteEngineName) !== false
      : engineAvailable(config, name as EngineName);
    return engines.has(name) && installed;
  });
}

/** An unprofiled Claude link in an engine chain is the employee's own account (the default's when it has none). */
function judgedOnEmployeeAccount(links: ResolvedFallbackLink[], input: ChooseSubstituteInput, accountMode: boolean): ResolvedFallbackLink[] {
  if (accountMode) return links;
  const account = accountForEmployee(input.employee, "claude");
  if (account === DEFAULT_CLAUDE_ACCOUNT) return links;
  return links.map((link) => (link.engine === "claude" && link.profile === undefined ? { ...link, account } : link));
}

/** The session's chain, resolved for the turn that just hit a limit. `health` is the reading for the host the turn runs on. */
export function resolveSubstituteChain(input: ChooseSubstituteInput, health: EngineHealthReading): SubstituteChain {
  const { config, employee, session, remote } = input;
  const own = sessionAtOwnTarget(session);
  // The scope is the one the turn ran under (its target, not a fresh read of the roster): a remote turn is walked as remote.
  const scope = { scoped: substituteScoped(session, input.remoteTarget), remote: Boolean(remote) };
  const registry = runtimeRegistry(input);
  const { source, links } = sessionFallbackChain({ config, employee, session: own, registry, health, scope });
  const namedModel = (link: ResolvedFallbackLink): string | undefined => (linkModelWritten(link) ? link.model : undefined);
  const accountMode = own.engine === "claude" && !remote;
  return { source, links: judgedOnEmployeeAccount(links, input, accountMode), accountMode, namedModel };
}
