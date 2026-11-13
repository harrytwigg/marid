import { sessionFallbackChain, type SessionFallbackChainOptions } from "../shared/fallback-chain.js";
import type { ResolvedFallbackLink } from "../shared/fallback-chain-wire.js";
import { logger } from "../shared/logger.js";
import { opencodeAccountStaging, type OpencodeAccountsReader } from "../engines/opencode-accounts.js";
import { getModelRegistry } from "../shared/models.js";
import { orgRegistry } from "./org-registry.js";
import { getSession } from "../sessions/registry.js";
import { sessionAtOwnTarget } from "../sessions/fallback-run.js";
import type { Employee, JinnConfig, ModelRegistry, Session } from "../shared/types.js";
import { opencodeAccountKeyEnvironment } from "../shared/child-env.js";

/**
 * Which opencode accounts a session may use (docs/design/opencode-accounts.md,
 * "Staging"). Each account's key is a secret of its own workspace, so a
 * session's opencode processes get only the accounts its chain can reach: the
 * provider of its own model and of every opencode link in its resolved chain
 * (its employee's, its account's or its engine's chain, or its stored
 * per-session target), and the provider of the model the turn runs on. A link
 * the session can never walk (a department-scoped session, or an engine the
 * session's host cannot run) reaches nothing.
 */

/** The provider of a `provider/model` id, or undefined for a bare model. */
function providerOf(model: string | null | undefined): string | undefined {
  const slash = model?.indexOf("/") ?? -1;
  return model && slash > 0 ? model.slice(0, slash) : undefined;
}

/** The session's resolved chain. A chain that cannot be resolved reaches nothing: no extra key is staged on a guess. */
function chainLinks(options: SessionFallbackChainOptions): ResolvedFallbackLink[] {
  try {
    return sessionFallbackChain(options).links;
  } catch (err) {
    logger.warn(`opencode accounts: the fallback chain of session ${options.session.id} could not be resolved, so only its own model's account is staged: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The opencode providers a session's chain names, with the turn's own model's. Empty when it names none. */
export function reachableOpencodeProviders(options: {
  config: JinnConfig;
  registry: ModelRegistry;
  session?: Session;
  employee?: Employee;
  /** The model the turn runs on. */
  model?: string;
  /** The department and host rules, when the caller already knows them. Default: read from the session and employee. */
  scope?: SessionFallbackChainOptions["scope"];
}): Set<string> {
  const { config, registry, session, employee, model, scope } = options;
  const providers = new Set<string>();
  const own = providerOf(model);
  if (own) providers.add(own);
  if (!session) return providers;
  for (const link of chainLinks({ config, employee, session: sessionAtOwnTarget(session), registry, health: {}, ...(scope ? { scope } : {}) })) {
    if (link.engine !== "opencode" || link.skip === "scoped" || link.skip === "remote") continue;
    const provider = providerOf(link.model);
    if (provider) providers.add(provider);
  }
  return providers;
}

/** The accounts reader for the engine and the server pool: a live view of the config, narrowed to the session asking. */
export function opencodeAccountsReaderFor(getConfig: () => JinnConfig): OpencodeAccountsReader {
  return ({ sessionId, model }) => {
    const config = getConfig();
    const session = sessionId ? getSession(sessionId) : undefined;
    const employee = session?.employee ? orgRegistry(config).get(session.employee) : undefined;
    const reach = reachableOpencodeProviders({ config, registry: getModelRegistry(config), session, employee, model });
    return opencodeAccountStaging(config, opencodeAccountKeyEnvironment(), reach);
  };
}
