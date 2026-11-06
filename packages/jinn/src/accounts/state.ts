import type { IncomingMessage } from "node:http";
import type { JinnConfig } from "../shared/types.js";
import { createAuthState } from "../gateway/auth.js";
import type { AccountsRuntime } from "./runtime.js";
import { countUsers } from "./users.js";

export type AuthStatePrincipal =
  | { kind: "operator" }
  | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: Array<{ department: string; role: string }> }
  | null;

type StateRequest = Pick<IncomingMessage, "headers" | "socket">;

/**
 * `GET /api/auth/state`: the existing browser-boot metadata plus two fields.
 *
 * `accountsEnabled` is true when gateway auth is required and at least one account exists, which is the
 * moment the sign-in form is offered (an instance with no accounts renders as it always did; whether
 * accounts are possible at all is `authRequired`). `principal` says who the request is. A member is not
 * `authenticated`: that field has always meant "holds operator credentials".
 */
export function buildAuthState(
  config: Pick<JinnConfig, "gateway">,
  req: StateRequest,
  gatewayAuthToken: string | undefined,
  jinnHome: string | undefined,
  accounts: AccountsRuntime | undefined,
): ReturnType<typeof createAuthState> & { accountsEnabled: boolean; principal: AuthStatePrincipal } {
  const base = createAuthState(config, req, gatewayAuthToken, jinnHome);
  if (!accounts) return { ...base, accountsEnabled: false, principal: base.authenticated ? { kind: "operator" } : null };
  let accountsEnabled = false;
  try {
    accountsEnabled = base.authRequired && countUsers(accounts.getDb()) > 0;
  } catch { /* an unreadable accounts table reads as no accounts */ }
  if (base.authenticated) return { ...base, accountsEnabled, principal: { kind: "operator" } };
  const principal = accounts.resolvePrincipal(req);
  if (principal.kind !== "member") return { ...base, accountsEnabled, principal: null };
  return {
    ...base,
    accountsEnabled,
    principal: {
      kind: "member",
      user: { id: principal.user.id, email: principal.user.email, displayName: principal.user.displayName },
      boards: accounts.boardsOf(principal.userId).map((grant) => ({ department: grant.department, role: grant.role })),
    },
  };
}
