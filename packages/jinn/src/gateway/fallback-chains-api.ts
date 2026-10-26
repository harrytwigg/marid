import type { ServerResponse } from "node:http";
import { engineHealthForTarget, readEngineHealth } from "../shared/engine-health.js";
import { employeeLimitAccounts, latestLimitReadings } from "../shared/fallback-chain-limits.js";
import { fallbackChainsResponse } from "../shared/fallback-chain-subjects.js";
import { getModelRegistry } from "../shared/models.js";
import { isRemoteTarget, sshDestination } from "../shared/remote-target.js";
import { availabilityRegistry, engineInstalledWhereRun } from "../sessions/availability-registry.js";
import type { Employee, JinnConfig, ModelRegistry } from "../shared/types.js";
import type { ApiContext } from "./api.js";
import { departmentScopeOf } from "./department-registry.js";
import { json, notFound, type ParsedRoute } from "./route-helpers.js";

/**
 * `GET /api/fallback-chains` (docs/fallback-chains.md): the declared Claude
 * profiles, and every engine's and declared account's chain as written and as it
 * would run, each link with its limit state. `?employee=<name>` adds that
 * employee's chain. Read-only: health and the limits readings come from what
 * the gateway already holds, and nothing is probed. Company configuration, so a
 * department-scoped caller is refused it (department-scope/rules.ts).
 */

async function getFallbackChains(res: ServerResponse, url: URL, context: ApiContext): Promise<void> {
  const config = context.getConfig();
  const { orgRegistry } = await import("./org-registry.js");
  const name = url.searchParams.get("employee");
  const employee = name ? orgRegistry(config).get(name) : undefined;
  if (name && !employee) return notFound(res);
  const health = engineHealthForTarget(readEngineHealth(), isRemoteTarget(employee) ? employee : undefined);
  const limits = latestLimitReadings(config, employee ? employeeLimitAccounts(employee, employee.engine) : []);
  const registry = getModelRegistry(config);
  json(res, fallbackChainsResponse({ config, registry, health, limits }, employee ? employeeChainInput(config, registry, employee) : undefined));
}

/**
 * What an employee's chain is judged by: its department's and host's scope, and,
 * for one on a remote host, a registry that asks that host's facts whether an
 * engine is installed, as its turns' walk does.
 */
function employeeChainInput(config: JinnConfig, registry: ModelRegistry, employee: Employee) {
  const host = isRemoteTarget(employee) ? sshDestination(employee) : undefined;
  const scope = { scoped: departmentScopeOf(employee.department) !== "open", remote: host !== undefined, ...(host ? { host } : {}) };
  if (!host) return { employee, scope };
  return { employee, scope, registry: availabilityRegistry(registry, (name) => registry[name] !== undefined && engineInstalledWhereRun(config, name, host)) };
}

/** `/api/fallback-chains`. See route-helpers.ts for the domain-module contract. */
export async function handleFallbackChainsApi(res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  if (route.method !== "GET" || route.pathname !== "/api/fallback-chains") return false;
  await getFallbackChains(res, route.url, context);
  return true;
}
