import { ownClaudeAccountOf, ownClaudeProfile } from "../sessions/session-account.js";
import { engineAllowedAsSubstitute, sessionSubstituteScope } from "../sessions/substitute-filters.js";
import { declaredAccountByKey, declaredClaudeAccounts } from "./claude-accounts-config.js";
import { linkAccount, ownTargetLink } from "./fallback-chain-links.js";
import { claudeAccountKey, DEFAULT_CLAUDE_ACCOUNT } from "./engine-account.js";
import { resolveSubstituteModel } from "./engine-fallback.js";
import { engineChain, expandFallbackChain, type FallbackExpansionMode } from "./fallback-chain-expand.js";
import { linkHealth, type FallbackHealthInputs } from "./fallback-chain-health.js";
import {
  fallbackLinkKey, fallbackLinkLabel,
  type FallbackChainEntry, type FallbackChainSource, type FallbackLink, type FallbackSkipReason, type ResolvedFallbackLink,
} from "./fallback-chain-wire.js";
import { engineSupportsRemote, REMOTE_ENGINE_CLI, type EngineName } from "./models.js";
import { remoteEngineAvailable } from "../engines/remote-stage.js";
import type { Employee, JinnConfig, ModelRegistry, Session } from "./types.js";

export { isLinkExhausted, linkHealthKey } from "./fallback-chain-health.js";
export { linkAccount, ownTargetLink } from "./fallback-chain-links.js";

/**
 * The chain resolver: which targets a subject falls back to, in order, and what
 * each one looks like for it. Pure and read-only: config, the model registry,
 * engine health and the latest cached limits reading go in, a resolved chain
 * comes out. It never probes anything.
 *
 * The runtime walks this chain (`sessions/rate-limit-substitute.ts`); the
 * expansion here visits targets in the order the walkers it replaced did, so a
 * chain written only in strings runs as it always has. See docs/fallback-chains.md.
 */

export interface FallbackChainEnv extends FallbackHealthInputs {
  config: JinnConfig;
  registry: ModelRegistry;
}

/** What a chain is resolved for: a session, or an engine, account or employee the editor shows. */
export interface FallbackChainSpec {
  /** The target the chain falls back from: index 0 of the resolved chain. */
  own: FallbackLink;
  /** Its account key (`claude`, `claude:<profile key>`, a remote login) or, off Claude, its engine. */
  ownAccount: string;
  /** The account an unprofiled Claude link in an `engine` chain runs as: the subject's own Claude login (a remote employee's, a named profile's). Default: the gateway's own `claude`. */
  claudeAccount?: string;
  entries: readonly FallbackChainEntry[];
  /** `account` for a local Claude subject, else `engine`: see fallback-chain-expand.ts. */
  mode: FallbackExpansionMode;
  /** Department-scoped, and/or running on a remote host (`host`: its ssh destination, when known). */
  scope: { scoped: boolean; remote: boolean; host?: string };
}

/**
 * The model a link runs: its own when it names one. Otherwise, on the session's
 * engine, the session's model; on another engine, the `fallbackModelMap`
 * translation of the session's model, else undefined (the engine's own default).
 */
export function resolveLinkModel(
  config: JinnConfig,
  registry: ModelRegistry,
  session: { engine: string; model?: string | null },
  link: FallbackLink,
): string | undefined {
  if (link.model !== undefined) return link.model;
  if (link.engine === session.engine) return session.model ?? undefined;
  return resolveSubstituteModel(config, registry, { from: session.engine, to: link.engine, model: session.model });
}

/** A profile that is not a declared account, or sits on a link that cannot take one. */
function profileUnknown(config: JinnConfig, link: FallbackLink): boolean {
  if (link.profile === undefined) return false;
  return link.engine !== "claude" || !declaredClaudeAccounts(config).some((account) => account.name === link.profile);
}

/** Why the subject's department or host rules the link out: a scoped session takes Claude only, a remote one an engine that runs on a host and no local profile. */
function scopeSkip(scope: FallbackChainSpec["scope"], link: FallbackLink): "scoped" | "remote" | undefined {
  const engine = link.engine as EngineName;
  if (!engineAllowedAsSubstitute({ scoped: scope.scoped, remote: false }, engine)) return "scoped";
  const remoteRefused = !engineAllowedAsSubstitute({ scoped: false, remote: scope.remote }, engine) || (scope.remote && link.profile !== undefined);
  return remoteRefused ? "remote" : undefined;
}

/** A model the link names that the registry, which lists models for the engine, does not serve. */
function modelNotServed(entry: ModelRegistry[string], link: FallbackLink): boolean {
  return link.model !== undefined && entry.models.length > 0 && !entry.models.some((model) => model.id === link.model);
}

/** Why a link cannot be used by this subject at all, if it cannot; `exhausted` and `tried` are the walk's to say, not this. */
function skipReason(env: FallbackChainEnv, subject: FallbackChainSpec, link: FallbackLink): FallbackSkipReason | undefined {
  if (profileUnknown(env.config, link)) return "profile-unknown";
  const entry = env.registry[link.engine];
  if (!entry?.available) return "not-installed";
  return scopeSkip(subject.scope, link) ?? (modelNotServed(entry, link) ? "model-not-served" : undefined);
}

/** What the gateway can add to a skip: the host that lacks a remote engine's CLI, when its facts say so (an engine the gateway has no adapter for is not the host's fault). */
function skipDetail(scope: FallbackChainSpec["scope"], link: FallbackLink, reason: FallbackSkipReason): string | undefined {
  if (reason !== "not-installed" || !scope.remote || !scope.host || !engineSupportsRemote(link.engine)) return undefined;
  if (remoteEngineAvailable(scope.host, link.engine) !== false) return undefined;
  return `${scope.host} has no \`${REMOTE_ENGINE_CLI[link.engine]}\` on its non-interactive PATH`;
}

function resolvedLink(
  env: FallbackChainEnv, link: FallbackLink, origin: ResolvedFallbackLink["origin"], written: FallbackLink, claudeAccount?: string,
): ResolvedFallbackLink {
  const account = linkAccount(link, env.config, claudeAccount);
  const identity = { ...link, key: fallbackLinkKey(link), account, label: fallbackLinkLabel(link), origin, written: { ...written } };
  return { ...identity, health: linkHealth(env, identity) };
}

/** A link with the model it would run, taken from the subject's own target. */
function withModel(env: FallbackChainEnv, subject: FallbackChainSpec, link: FallbackLink): FallbackLink {
  const model = resolveLinkModel(env.config, env.registry, subject.own, link);
  return { engine: link.engine, ...(link.profile === undefined ? {} : { profile: link.profile }), ...(model === undefined ? {} : { model }) };
}

/**
 * The subject's chain, resolved: index 0 is its own target, then the effective
 * chain (legacy strings expanded in place) with each link's model, account,
 * label, health and skip reason. A link that resolves to a target already listed
 * (the own one included) is dropped: it is the same target.
 */
export function resolveFallbackLinks(env: FallbackChainEnv, subject: FallbackChainSpec): ResolvedFallbackLink[] {
  // An account chain names its Claude accounts itself; an engine chain's unprofiled Claude link is the subject's own login.
  const claudeAccount = subject.mode === "engine" ? subject.claudeAccount : undefined;
  const own = resolvedLink(env, subject.own, "config", subject.own, claudeAccount);
  const seen = new Set<string>([own.key]);
  const expanded = expandFallbackChain(env.config, subject.entries, { mode: subject.mode, selfAccount: subject.ownAccount, selfKey: own.key });
  const links: ResolvedFallbackLink[] = [own];
  for (const { link, origin } of expanded) {
    const target = withModel(env, subject, link);
    const resolved = resolvedLink(env, target, origin, link, claudeAccount);
    if (seen.has(resolved.key)) continue;
    seen.add(resolved.key);
    const skip = skipReason(env, subject, target);
    const detail = skip ? skipDetail(subject.scope, target, skip) : undefined;
    links.push(skip ? { ...resolved, skip, ...(detail ? { skipDetail: detail } : {}) } : resolved);
  }
  return links;
}

/**
 * The chain a target inherits when no session or employee names one: its
 * declared account's, else (for the default profile and every other engine) its
 * engine's. A named local profile that is not declared has none.
 */
export function inheritedChain(
  config: JinnConfig, engine: string, mode: FallbackExpansionMode, ownAccount: string,
): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } {
  if (mode === "account" && ownAccount !== DEFAULT_CLAUDE_ACCOUNT) {
    const declared = declaredAccountByKey(config, ownAccount);
    return declared ? { source: "account", entries: declared.fallback ?? [] } : { source: "none", entries: [] };
  }
  return { source: "engine", entries: engineChain(config, engine) };
}

/** Which chain a session gets, first match wins: its own target, its employee's chain, then what its account and engine give. */
function chainSource(
  config: JinnConfig, session: Session, employee: Employee | undefined, mode: FallbackExpansionMode, ownAccount: string,
): { source: FallbackChainSource; entries: readonly FallbackChainEntry[] } {
  const target = session.fallbackTarget;
  if (target) return { source: "session", entries: [{ engine: target.engine, model: target.model }] };
  if (employee?.fallback !== undefined) return { source: "employee", entries: employee.fallback };
  return inheritedChain(config, session.engine, mode, ownAccount);
}

export interface SessionFallbackChainOptions extends FallbackHealthInputs {
  config: JinnConfig;
  employee?: Employee;
  session: Session;
  registry: ModelRegistry;
  /** The department and host rules, when the caller already knows them (a turn that ran on a remote target the roster does not name). Default: read from the session and employee. */
  scope?: FallbackChainSpec["scope"];
}

/**
 * A session's chain, resolved: its own fallback target (one link), else its
 * employee's `fallback`, else its declared account's chain, else its engine's
 * default. A named local profile that is not declared and whose employee writes
 * no `fallback` has none (source `none`: it waits for its own reset).
 */
export function sessionFallbackChain(options: SessionFallbackChainOptions): { source: FallbackChainSource; links: ResolvedFallbackLink[] } {
  const { config, employee, session, registry, scope: givenScope, ...inputs } = options;
  const scope = givenScope ?? sessionSubstituteScope(session, employee, config);
  const mode: FallbackExpansionMode = session.engine === "claude" && !scope.remote ? "account" : "engine";
  // The session's own Claude login: the profile it was started on, else its employee's.
  const claudeAccount = ownClaudeAccountOf(session, employee);
  const ownAccount = session.engine === "claude" ? claudeAccount : session.engine;
  const ownProfile = session.engine === "claude" && !scope.remote ? claudeAccountKey(ownClaudeProfile(session, employee)) : undefined;
  const own = ownTargetLink(config, { engine: session.engine, model: session.model, account: ownProfile });
  const { source, entries } = chainSource(config, session, employee, mode, ownAccount);
  const env: FallbackChainEnv = { config, registry, ...inputs };
  return { source, links: resolveFallbackLinks(env, { own, ownAccount, claudeAccount, entries, mode, scope }) };
}
