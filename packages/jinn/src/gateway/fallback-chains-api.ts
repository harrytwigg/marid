import type { ServerResponse } from "node:http";
import { engineHealthForTarget, readEngineHealth } from "../shared/engine-health.js";
import { latestLimitReadings } from "../shared/fallback-chain-limits.js";
import { fallbackChainsResponse } from "../shared/fallback-chain-subjects.js";
import { getModelRegistry } from "../shared/models.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { accountForEmployee } from "../shared/engine-account.js";
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
  const limits = latestLimitReadings(config, employee ? [accountForEmployee(employee, employee.engine)] : []);
  const scope = employee ? { scoped: departmentScopeOf(employee.department) !== "open", remote: isRemoteTarget(employee) } : undefined;
  json(res, fallbackChainsResponse({ config, registry: getModelRegistry(config), health, limits }, employee && scope ? { employee, scope } : undefined));
}

/** `/api/fallback-chains`. See route-helpers.ts for the domain-module contract. */
export async function handleFallbackChainsApi(res: ServerResponse, route: ParsedRoute, context: ApiContext): Promise<boolean> {
  if (route.method !== "GET" || route.pathname !== "/api/fallback-chains") return false;
  await getFallbackChains(res, route.url, context);
  return true;
}
