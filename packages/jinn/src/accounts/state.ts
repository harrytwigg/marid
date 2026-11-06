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
 * `GET /api/auth/state`: the existing browser-boot metadata plus three fields.
 *
 * `accountsEnabled` is true when gateway auth is required, so accounts are possible; `hasAccounts` is true
 * once at least one exists, and the sign-in form is offered when both are (an instance with no accounts
 * renders as it always did). `principal` says who the request is. A member is not
 * `authenticated`: that field has always meant "holds operator credentials".
 */
export function buildAuthState(
  config: Pick<JinnConfig, "gateway">,
  req: StateRequest,
  gatewayAuthToken: string | undefined,
  jinnHome: string | undefined,
  accounts: AccountsRuntime | undefined,
): ReturnType<typeof createAuthState> & { accountsEnabled: boolean; hasAccounts: boolean; principal: AuthStatePrincipal } {
  const base = createAuthState(config, req, gatewayAuthToken, jinnHome);
  if (!accounts) return { ...base, accountsEnabled: false, hasAccounts: false, principal: base.authenticated ? { kind: "operator" } : null };
  // Accounts are possible where gateway auth is on; the sign-in form shows once one exists too.
  const accountsEnabled = base.authRequired;
  let hasAccounts = false;
  try {
    hasAccounts = accountsEnabled && countUsers(accounts.getDb()) > 0;
  } catch { /* an unreadable accounts table reads as no accounts */ }
  if (base.authenticated) return { ...base, accountsEnabled, hasAccounts, principal: { kind: "operator" } };
  const principal = accounts.resolvePrincipal(req);
  if (principal.kind !== "member") return { ...base, accountsEnabled, hasAccounts, principal: null };
  return {
    ...base,
    accountsEnabled,
    hasAccounts,
    principal: {
      kind: "member",
      user: { id: principal.user.id, email: principal.user.email, displayName: principal.user.displayName },
      boards: accounts.boardsOf(principal.userId).map((grant) => ({ department: grant.department, role: grant.role })),
    },
  };
}
