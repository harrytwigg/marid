import { isBoardWalkTurn } from "../board-walk/started-sessions.js";
import { accountHasChain, resolveHealthyAccountFallback, type AccountFallbackOptions } from "../shared/account-fallback.js";
import { declaredAccountByKey } from "../shared/claude-accounts-config.js";
import type { ClaudeProfile } from "../shared/claude-profile.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { engineHealthForTarget, readEngineHealth, resolveHealthyFallbackEngine, type EngineHealthReading } from "../shared/engine-health.js";
import { engineAvailable, engineSupportsRemote, type EngineName } from "../shared/models.js";
import { sshDestination } from "../shared/remote-target.js";
import type { Employee, JinnConfig, RemoteTarget, Session } from "../shared/types.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import { resolveEmployeeClaudeProfile, substituteHealth } from "./rate-limit-account.js";

/** What a rate-limited turn moves onto: an engine, the Claude profile it runs
 *  as there, and, for another Claude account, the swap the override records. */
export interface SubstituteChoice {
  engine: EngineName;
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
  remoteTarget: RemoteTarget;
  options?: AccountFallbackOptions;
}

function fallbackModelMapOf(config: JinnConfig, account: string): Record<string, string> | undefined {
  return account === DEFAULT_CLAUDE_ACCOUNT ? config.engines.claude?.fallbackModelMap : declaredAccountByKey(config, account)?.fallbackModelMap;
}

/**
 * The substitute for a rate-limited turn, or undefined when it should wait for
 * its own reset (Branch B).
 *
 * - A board walk turn never changes engine or account (FR-076).
 * - A remote employee keeps today's rule: an engine that can also run on its
 *   host. Account entries apply to local sessions only in v1.
 * - A local Claude session walks its account's own chain (FR-079): the default
 *   account's `engines.claude.fallback`, or a declared account's. An
 *   undeclared named profile has none and waits (FR-056).
 * - Any other local session walks its engine's chain, as before accounts.
 */
export function chooseSubstitute(input: ChooseSubstituteInput): SubstituteChoice | undefined {
  if (isBoardWalkTurn(input.session)) return undefined;
  // Health recorded about the gateway's own login says nothing about the host
  // this turn is going back to.
  const health = engineHealthForTarget(readEngineHealth(), input.remoteTarget);
  return !input.remote && input.session.engine === "claude" ? accountSubstitute(input, health) : engineSubstitute(input, health);
}

/** A local Claude session: its account's own chain (FR-079). */
function accountSubstitute(input: ChooseSubstituteInput, health: EngineHealthReading): SubstituteChoice | undefined {
  const { config, engines, account } = input;
  if (!accountHasChain(config, account)) return undefined;
  const target = resolveHealthyAccountFallback(config, account,
    (candidate) => engines.has(candidate.engine) && engineAvailable(config, candidate.engine), health, input.options);
  if (!target) return undefined;
  if (target.engine !== "claude") return { engine: target.engine, claudeProfile: null };
  const profile = target.account === DEFAULT_CLAUDE_ACCOUNT ? null : declaredAccountByKey(config, target.account)?.profile ?? null;
  return {
    engine: "claude",
    claudeProfile: profile,
    accounts: { original: account, substitute: target.account, substituteConfigDir: profile?.dir ?? null, fallbackModelMap: fallbackModelMapOf(config, account) },
  };
}

/** Every other session: its engine's chain, as before accounts. */
function engineSubstitute(input: ChooseSubstituteInput, health: EngineHealthReading): SubstituteChoice | undefined {
  const { config, engines, session, employee, remote } = input;
  // A remote employee's substitute has to be an engine that can ALSO run on that
  // host, and the usability question moves there with it: `engineAvailable`
  // probes the GATEWAY's PATH, which says nothing about another machine.
  const isUsable = (candidate: EngineName) => engines.has(candidate) && (remote
    ? engineSupportsRemote(candidate) && remoteEngineAvailable(sshDestination(remote), candidate) !== false
    : engineAvailable(config, candidate));
  const name = resolveHealthyFallbackEngine(config, session.engine, isUsable, substituteHealth(health, employee));
  if (!name) return undefined;
  // A non-Claude session falling to claude runs as its employee's own profile.
  return { engine: name, claudeProfile: name === "claude" && !remote ? resolveEmployeeClaudeProfile(employee) : null };
}
