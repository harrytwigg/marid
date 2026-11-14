import { matchRoute } from "../gateway/route-helpers.js";
import { requireOperator, type AccountRouteContext } from "./routes-common.js";

export interface OperatorRoute {
  method: string;
  /** `/api/x/:param` style; literal patterns must precede a parameterised one that would also match. */
  pattern: string;
  run(ctx: AccountRouteContext, params: Record<string, string>): void | Promise<void>;
}

/**
 * Run the first route that matches this method and path, behind the operator gate. False when none does
 * (the request falls through to the dispatcher's own 404); the gate is only asked once a route matched,
 * so an unknown path leaks nothing and a known one is never reachable by a non-operator.
 */
export async function runOperatorRoutes(routes: readonly OperatorRoute[], ctx: AccountRouteContext): Promise<boolean> {
  for (const route of routes) {
    if (route.method !== ctx.route.method) continue;
    const params = matchRoute(route.pattern, ctx.route.pathname);
    if (!params) continue;
    if (!requireOperator(ctx)) return true;
    await route.run(ctx, params);
    return true;
  }
  return false;
}
