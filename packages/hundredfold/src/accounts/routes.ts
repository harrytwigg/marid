import type { IncomingMessage, ServerResponse } from "node:http";
import type { ParsedRoute } from "../gateway/route-helpers.js";
import { handleAccountRoute } from "./routes-account.js";
import { handleBoardsRoute } from "./routes-boards.js";
import { handlePeopleRoute } from "./routes-people.js";
import { handlePublicAccountRoute } from "./routes-public.js";
import type { AccountsApiDeps } from "./routes-common.js";

export type { AccountsApiDeps } from "./routes-common.js";

/**
 * The account endpoints of the general API: sign-in, invites and resets (no credential needed), and the
 * operator's People, account and board-share routes. True when the request was answered.
 *
 * Without an accounts runtime (a bare test context) none of these exist and the request falls through.
 */
export async function handleAccountsApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: ParsedRoute,
  deps: AccountsApiDeps,
): Promise<boolean> {
  const rt = deps.accounts;
  if (!rt) return false;
  const ctx = { req, res, route, rt, deps };
  return (await handlePublicAccountRoute(ctx))
    || (await handlePeopleRoute(ctx))
    || (await handleAccountRoute(ctx))
    || (await handleBoardsRoute(ctx));
}
