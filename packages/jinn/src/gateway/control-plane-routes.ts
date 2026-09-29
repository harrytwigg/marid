import { pluginAdminAction } from "./plugins-admin-api.js";
import { matchRoute } from "./route-helpers.js";

/**
 * The gateway-control routes only the operator may drive: a capability-bound
 * session is refused them whatever its rank. Moved out of `api.ts`
 * to pay for that file's size budget, and made a table on the way so it is
 * readable and within the complexity limit; `api.ts` still enforces it. First
 * match wins, in the order the original chain tested them. A route ending in
 * `*` is a prefix.
 */
const OPERATOR_ONLY_ROUTES: ReadonlyArray<readonly [method: string, route: string, action: string]> = [
  ["PUT", "/api/config", "config update"],
  ["PATCH", "/api/config", "config update"],
  ["POST", "/api/onboarding", "onboarding config update"],
  ["POST", "/api/instances", "workspace creation"],
  ["POST", "/api/instances/:id/start", "workspace start"],
  ["DELETE", "/api/auth/devices/*", "auth device revoke"],
  ["POST", "/api/engines/refresh", "engine registry refresh"],
  ["POST", "/api/engine-limits/refresh", "engine limits refresh"],
  ["POST", "/api/connectors/reload", "connector reload"],
  ["POST", "/api/stt/download", "STT model download/config enable"],
  ["PUT", "/api/stt/config", "STT config update"],
  ["DELETE", "/api/sessions/:id", "session delete"],
  ["PUT", "/api/sessions/:id", "session metadata/model update"],
  ["PATCH", "/api/sessions/:id", "session metadata/model update"],
  ["POST", "/api/sessions/:id/duplicate", "session duplicate"],
  ["POST", "/api/sessions/:id/archive", "session archive"],
  ["POST", "/api/sessions/:id/unarchive", "session unarchive"],
  ["POST", "/api/sessions/:id/reset", "session reset"],
  ["POST", "/api/sessions/bulk-delete", "session bulk delete"],
  ["POST", "/api/todo-captures", "quick capture"],
  ["POST", "/api/pins", "chat pin update"],
  ["DELETE", "/api/pins/:key", "chat pin update"],
  ["DELETE", "/api/sessions/:id/queue/:itemId", "session queue item cancel"],
  ["PATCH", "/api/sessions/:id/queue/:itemId", "session queue item edit"],
  ["POST", "/api/sessions/:id/queue/:itemId/send-now", "session queue item send now"],
  ["DELETE", "/api/sessions/:id/queue", "session queue clear"],
  ["POST", "/api/sessions/:id/queue/pause", "session queue pause"],
  ["POST", "/api/sessions/:id/queue/resume", "session queue resume"],
  ["POST", "/api/cron", "cron create"],
  ["PUT", "/api/cron/:id", "cron update"],
  ["DELETE", "/api/cron/:id", "cron delete"],
  ["POST", "/api/cron/:id/trigger", "cron manual trigger"],
  ["PATCH", "/api/org/employees/:name", "org employee update"],
  ["DELETE", "/api/skills/:name", "skill removal"],
  ["PUT", "/api/skills/:name", "skill update"],
];

function routeMatches(route: string, pathname: string): boolean {
  if (route.endsWith("*")) return pathname.startsWith(route.slice(0, -1));
  return route.includes(":") ? matchRoute(route, pathname) !== null : route === pathname;
}

export function operatorOnlyControlPlaneRoute(method: string, pathname: string): string | null {
  const hit = OPERATOR_ONLY_ROUTES.find(([routeMethod, route]) => routeMethod === method && routeMatches(route, pathname));
  return hit ? hit[2] : pluginAdminAction(method, pathname);
}
