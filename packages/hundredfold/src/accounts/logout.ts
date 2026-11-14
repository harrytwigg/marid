import type { IncomingMessage } from "node:http";
import { clearUserCookieHeader, requestUserToken } from "./cookie.js";
import type { AccountsRuntime } from "./runtime.js";
import { resolveUserSession, revokeUserSession } from "./user-sessions.js";

/**
 * Sign-out for a browser that also holds a member session: revoke it and return the header that clears its
 * cookie. Empty when the request carries no member cookie, so logout on an instance with no accounts is
 * byte-for-byte what it was.
 */
export function signOutUserSession(req: Pick<IncomingMessage, "headers">, accounts: AccountsRuntime | undefined): string[] {
  if (!accounts) return [];
  const token = requestUserToken(req.headers, accounts.home);
  if (!token) return [];
  try {
    const db = accounts.getDb();
    const resolved = resolveUserSession(db, token, accounts.now());
    if (resolved) revokeUserSession(db, resolved.session.id, accounts.now());
  } catch { /* clearing the cookie still goes out */ }
  return [clearUserCookieHeader(accounts.home)];
}
