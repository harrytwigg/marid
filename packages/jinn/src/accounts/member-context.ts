import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { JinnConfig } from "../shared/types.js";
import type { ParsedRoute } from "../gateway/route-helpers.js";
import type { AccountsRuntime, MemberPrincipal } from "./runtime.js";
import type { AccountRouteContext } from "./routes-common.js";

export interface MemberRouterDeps {
  accounts: AccountsRuntime;
  getConfig: () => Pick<JinnConfig, "gateway"> & Partial<JinnConfig>;
  gatewayAuthToken: string | undefined;
  home: string;
  /** The gateway broadcast: member writes announce themselves on it like any other write, and the operator's browsers hear them. */
  emit?: GatewayEmit;
}

/** What a member route is given: the request, who is asking, and the path's parameters. */
export interface MemberRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  principal: MemberPrincipal;
  deps: MemberRouterDeps;
  route: ParsedRoute;
  params: Record<string, string>;
}

export interface MemberRoute {
  method: string;
  /** `/api/member/x/:param` style; a literal pattern must precede a parameterised one that would also match. */
  pattern: string;
  run(ctx: MemberRouteContext): void | Promise<void>;
}

/** `AccountRouteContext` for a member: the same helpers the operator's account routes use, with no operator behind them. */
export function accountContext(ctx: MemberRouteContext): AccountRouteContext {
  return {
    req: ctx.req, res: ctx.res, route: ctx.route, rt: ctx.deps.accounts,
    deps: { accounts: ctx.deps.accounts, isOperator: () => false, rejectIdentityGrant: () => false },
  };
}
