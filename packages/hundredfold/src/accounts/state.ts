import type { IncomingMessage } from "node:http";
import type { HundredfoldConfig } from "../shared/types.js";
import { authSessionUserId, createAuthState, verifiedAuthDeviceId } from "../gateway/auth.js";
import type { AccountsRuntime } from "./runtime.js";
import { countUsers, getUserById } from "./users.js";

export type AuthStatePrincipal =
  | { kind: "operator"; user?: { id: string; displayName: string } }
  | { kind: "member"; user: { id: string; email: string; displayName: string }; boards: Array<{ department: string; role: string }> }
  | null;

type StateRequest = Pick<IncomingMessage, "headers" | "socket">;

/**
 * `GET /api/auth/state`: the existing browser-boot metadata plus three fields.
 *
 * `accountsEnabled` is true when gateway auth is required, so accounts are possible; `hasAccounts` is true
 * once at least one exists, and the sign-in form is offered when both are (an instance with no accounts
 * renders as it always did). `principal` says who the request is. A member is not
 * `authenticated`: that field has always meant "holds operator credentials". An operator principal carries `user` when
 * this browser's device session is linked to an active instance-owner account (its password sign-in, or "set up my
 * sign-in"); a paired device, the bearer token, a disabled owner or a member-role link carry none.
 */
export function buildAuthState(
  config: Pick<HundredfoldConfig, "gateway">,
  req: StateRequest,
  gatewayAuthToken: string | undefined,
  hundredfoldHome: string | undefined,
  accounts: AccountsRuntime | undefined,
): ReturnType<typeof createAuthState> & { accountsEnabled: boolean; hasAccounts: boolean; principal: AuthStatePrincipal } {
  const base = createAuthState(config, req, gatewayAuthToken, hundredfoldHome);
  if (!accounts) return { ...base, accountsEnabled: false, hasAccounts: false, principal: base.authenticated ? { kind: "operator" } : null };
  // Accounts are possible where gateway auth is on; the sign-in form shows once one exists too.
  const accountsEnabled = base.authRequired;
  let hasAccounts = false;
  try {
    hasAccounts = accountsEnabled && countUsers(accounts.getDb()) > 0;
  } catch { /* an unreadable accounts table reads as no accounts */ }
  if (base.authenticated) {
    const user = operatorAccountOf(req, hundredfoldHome, accounts);
    return { ...base, accountsEnabled, hasAccounts, principal: user ? { kind: "operator", user } : { kind: "operator" } };
  }
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

/** The active owner account this request's device session is linked to, if any: the device whose session cookie verified,
 *  never an id cookie alone. Never throws: an unreadable device store or accounts table reads as no account. */
function operatorAccountOf(req: StateRequest, hundredfoldHome: string | undefined, accounts: AccountsRuntime): { id: string; displayName: string } | undefined {
  if (!hundredfoldHome) return undefined;
  try {
    const userId = authSessionUserId(hundredfoldHome, verifiedAuthDeviceId(req.headers, hundredfoldHome));
    if (!userId) return undefined;
    const user = getUserById(accounts.getDb(), userId);
    return user && user.status === "active" && user.instanceRole === "owner" ? { id: user.id, displayName: user.displayName } : undefined;
  } catch {
    return undefined;
  }
}
