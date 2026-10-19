import { declaredAccountByKey } from "../shared/claude-accounts-config.js";
import { DEFAULT_CLAUDE_ACCOUNT } from "../shared/engine-account.js";
import { resolveSubstituteModel } from "../shared/engine-fallback.js";
import { sessionFallbackChain } from "../shared/fallback-chain.js";
import { linkModelWritten } from "../shared/fallback-chain-links.js";
import { effectivePosition } from "../shared/fallback-chain-next.js";
import type { ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import { isSpellableModelId } from "../shared/model-id.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import {
  DEFAULT_SESSION_FALLBACK_MODE, isSessionFallbackMode,
  type SessionFallbackMode, type SessionFallbackTarget, type SessionFallbackView, type StoredFallbackTarget,
} from "../shared/session-fallback-config.js";
import type { Employee, JinnConfig, ModelRegistry, Session } from "../shared/types.js";
import { isKnownEngine, type EngineName } from "../shared/models.js";
import type { FallbackHealthInputs } from "../shared/fallback-chain-health.js";
import { sessionFallbackChainView } from "./session-fallback-chain.js";
import { rateLimitAccount } from "./rate-limit-account.js";
import { rateLimitRemoteTarget } from "./rate-limit-remote-target.js";
import { metaOf, readFallbackRun, sessionAtOwnTarget } from "./fallback-run.js";
import { engineAllowedAsSubstitute, fallbackModelMapOf, sessionSubstituteScope, substituteScoped } from "./substitute-filters.js";

/**
 * Per-session usage-limit behaviour (`fallbackMode`): which mode a session
 * follows, what its children get, and what it would fall back to. Pure
 * functions of config and the session row; enforcement lives where the
 * decision is made (`chooseSubstitute`, the creation-time reroute, the
 * engine-override revert).
 */

type ConfigView = { sessions?: JinnConfig["sessions"] };

/** The mode the config gives a session that has none of its own. */
export function configFallbackMode(config: ConfigView): SessionFallbackMode {
  const configured = config.sessions?.fallbackMode;
  return isSessionFallbackMode(configured) ? configured : DEFAULT_SESSION_FALLBACK_MODE;
}

/** The session's own mode, else the config's, and which of the two answered. */
export function effectiveFallbackMode(
  config: ConfigView,
  session: Pick<Session, "fallbackMode"> | undefined,
): { mode: SessionFallbackMode; source: "session" | "default" } {
  const own = session?.fallbackMode;
  return isSessionFallbackMode(own) ? { mode: own, source: "session" } : { mode: configFallbackMode(config), source: "default" };
}

/** Whether the session never switches model at a usage limit. */
export function isAutoResume(config: ConfigView, session: Pick<Session, "fallbackMode"> | undefined): boolean {
  return effectiveFallbackMode(config, session).mode === "auto-resume";
}

/** Whether a session about to be created with `mode` (undefined: the config's) starts on the
 *  engine it prefers instead of an allowance reroute. */
export function startsOnPreferredEngine(config: ConfigView, mode: SessionFallbackMode | null | undefined): boolean {
  return (mode ?? configFallbackMode(config)) === "auto-resume";
}

/**
 * The mode to store on a session being created. An explicit mode wins. With no
 * parent it is undefined (NULL: a root follows the config default). A child of a
 * `fallback-children` parent inherits it; a child of any other parent gets
 * `auto-resume`, so by default only the root of a tree falls back.
 */
export function childFallbackMode(
  config: ConfigView,
  parent: Pick<Session, "fallbackMode"> | undefined,
  explicit?: SessionFallbackMode,
): SessionFallbackMode | undefined {
  if (explicit) return explicit;
  if (!parent) return undefined;
  return effectiveFallbackMode(config, parent).mode === "fallback-children" ? "fallback-children" : "auto-resume";
}

function engineDefaultModel(config: JinnConfig, registry: ModelRegistry, engine: string): string | undefined {
  return config.engines[engine as EngineName]?.model ?? registry[engine]?.defaultModel ?? undefined;
}

/** An engine standing in: the model the session's pin maps to when the substitute serves it,
 *  else the substitute's own configured or default model. */
function engineTarget(config: JinnConfig, registry: ModelRegistry, session: Session, to: string): SessionFallbackTarget {
  const model = resolveSubstituteModel(config, registry, { from: session.engine, to, model: session.model ?? engineDefaultModel(config, registry, session.engine) })
    ?? engineDefaultModel(config, registry, to);
  return { engine: to, ...(model ? { model } : {}), label: model ?? to };
}

/** An account as people name it: `claude` for the default, else `claude:<declared name>`. */
function accountName(config: JinnConfig, account: string): string {
  if (account === DEFAULT_CLAUDE_ACCOUNT) return account;
  return `claude:${declaredAccountByKey(config, account)?.name ?? account.slice(DEFAULT_CLAUDE_ACCOUNT.length + 1)}`;
}

/** The pin an account swap carries: through the limited account's map when it maps it, else as it is. */
function accountSwapPin(config: JinnConfig, from: string, pin: string | null): string | undefined {
  const mapped = pin ? fallbackModelMapOf(config, from)?.[pin] : undefined;
  return typeof mapped === "string" && isSpellableModelId(mapped) ? mapped : pin ?? undefined;
}

/** Another Claude account standing in keeps the engine, and the pin through the account's map. */
function accountTarget(config: JinnConfig, session: Session, from: string, account: string): SessionFallbackTarget {
  const model = accountSwapPin(config, from, session.model);
  const name = accountName(config, account);
  return { engine: "claude", account, ...(model ? { model } : {}), label: model ? `${name} · ${model}` : name };
}

/** A link the chain names, as the view shows the target: a Claude account swap or an engine standing in, with the model the link names when it names one. */
function linkTarget(config: JinnConfig, registry: ModelRegistry, own: Session, from: string, link: ResolvedFallbackLink): SessionFallbackTarget {
  const base = from !== "" && link.engine === "claude" ? accountTarget(config, own, from, link.account) : engineTarget(config, registry, own, link.engine);
  // A model the entry wrote is the target's; one it inherits from the session is derived as a swap derives it.
  if (!linkModelWritten(link) || !link.model) return base;
  const prefix = base.account ? `${accountName(config, base.account)} · ` : "";
  return { ...base, model: link.model, label: `${prefix}${link.model}` };
}

/**
 * What the session would fall back to, from config alone: no health and no check that
 * a binary is installed. It reads the chain `chooseSubstitute` walks, with the same scoped
 * and remote filters, from where the session's run stands, so it answers "where would this
 * go if its model were limited now". Null when the chain is empty or has nothing the
 * session may use.
 */
export function resolveSessionFallbackTarget(
  config: JinnConfig,
  registry: ModelRegistry,
  session: Session,
  employee?: Employee,
): SessionFallbackTarget | null {
  const remoteTarget = rateLimitRemoteTarget({ session, employee, config });
  const scope = { scoped: substituteScoped(session, remoteTarget), remote: isRemoteTarget(remoteTarget) };
  const own = sessionAtOwnTarget(session);
  const { links } = sessionFallbackChain({ config, employee, session: own, registry, health: {}, scope });
  const run = readFallbackRun(metaOf(session));
  const position = effectivePosition(links, run);
  const tried = new Set([...(run?.tried ?? []), links[0]!.key, links[position]!.key]);
  // Whether a binary is installed is the turn's question, not this display's: only an engine the registry does not know at all is passed over.
  const next = links.slice(position + 1).find((link) => !tried.has(link.key) && registry[link.engine] !== undefined && (link.skip === undefined || link.skip === "not-installed"));
  if (!next) return null;
  // A local Claude session swaps accounts; any other session (or a remote one) has an engine stand in.
  const from = session.engine === "claude" && !scope.remote ? rateLimitAccount("claude", employee, session).account : "";
  return linkTarget(config, registry, own, from, next);
}

/** The session's own chosen target as the view shows it: the model's label when the registry has one. */
function ownTarget(registry: ModelRegistry, own: StoredFallbackTarget): SessionFallbackTarget {
  const label = registry[own.engine]?.models.find((m) => m.id === own.model)?.label ?? own.model;
  return { engine: own.engine, model: own.model, label };
}

/** The installed engines this session may name as its own fallback: the substitute walk's filters. */
function allowedFallbackEngines(config: JinnConfig, registry: ModelRegistry, session: Session, employee?: Employee): string[] {
  const scope = sessionSubstituteScope(session, employee, config);
  return Object.entries(registry)
    .filter(([name, entry]) => entry.available && isKnownEngine(name) && engineAllowedAsSubstitute(scope, name))
    .map(([name]) => name);
}

/** What `GET /api/sessions/:id` reports for fallback. `inputs` is the engine health and cached limits readings the chain reads its link states from; without them every link reads ok. */
export function sessionFallbackView(
  config: JinnConfig,
  registry: ModelRegistry,
  session: Session,
  employee?: Employee,
  inputs: FallbackHealthInputs = { health: {} },
): SessionFallbackView {
  const { mode, source } = effectiveFallbackMode(config, session);
  const allowedEngines = allowedFallbackEngines(config, registry, session, employee);
  const chain = sessionFallbackChainView({ config, registry, session, employee, ...inputs });
  if (session.fallbackTarget) return { mode, modeSource: source, target: ownTarget(registry, session.fallbackTarget), targetSource: "session", allowedEngines, chain };
  return { mode, modeSource: source, target: resolveSessionFallbackTarget(config, registry, session, employee), targetSource: "config", allowedEngines, chain };
}
