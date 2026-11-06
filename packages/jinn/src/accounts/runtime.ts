import type { Database as DatabaseType } from "better-sqlite3";
import type { IncomingMessage } from "node:http";
import { verifyGatewayAuth } from "../gateway/auth.js";
import { requestUserToken } from "./cookie.js";
import { createMemberSocketRegistry, type MemberSocketRegistry } from "./member-sockets.js";
import { createHashLimiter, globalHashLimiter, type HashLimiter } from "./passwords.js";
import { listGrantsForUser, type BoardGrant } from "./board-members.js";
import { onUserSessionsRevoked, resolveUserSession, touchUserSession } from "./user-sessions.js";
import type { UserRecord } from "./users.js";

export type Principal =
  | { kind: "operator" }
  | { kind: "member"; userId: string; sessionId: string; user: UserRecord }
  | { kind: "none" };

export type MemberPrincipal = Extract<Principal, { kind: "member" }>;

type RequestLike = Pick<IncomingMessage, "headers" | "socket">;

export interface AccountsRuntime {
  readonly home: string;
  getDb(): DatabaseType;
  /** Read live: `config.yaml` reloads while the server is up. */
  authRequired(): boolean;
  now(): number;
  limiter: HashLimiter;
  memberSockets: MemberSocketRegistry;
  /** Whether a board (department) exists to be shared. */
  departmentExists(slug: string): boolean;
  /** The one function HTTP and the upgrade handler both ask who is calling. */
  resolvePrincipal(req: RequestLike): Principal;
  boardsOf(userId: string): BoardGrant[];
  dispose(): void;
}

export interface AccountsRuntimeOptions {
  getDb: () => DatabaseType;
  home: string;
  authRequired: () => boolean;
  gatewayAuthToken: string | undefined;
  now?: () => number;
  limiter?: HashLimiter;
  /** Whether a slug names a department the gateway knows. When given it is the whole rule; otherwise only a `departments` row counts. */
  knownDepartment?: (slug: string) => boolean;
}

export function createAccountsRuntime(opts: AccountsRuntimeOptions): AccountsRuntime {
  const now = opts.now ?? Date.now;
  const memberSockets = createMemberSocketRegistry({ getDb: opts.getDb, authRequired: opts.authRequired, now });
  const stopListening = onUserSessionsRevoked(() => { memberSockets.sweep(); });

  function resolvePrincipal(req: RequestLike): Principal {
    // 1. An operator credential wins over a user cookie on the same request, exactly as it works today.
    if (verifyGatewayAuth(req.headers, opts.gatewayAuthToken, opts.home)) return { kind: "operator" };
    // 2. A member exists only where gateway auth is required (otherwise every browser is the operator).
    if (!opts.authRequired()) return { kind: "none" };
    const token = requestUserToken(req.headers, opts.home);
    if (!token) return { kind: "none" };
    try {
      const db = opts.getDb();
      const resolved = resolveUserSession(db, token, now());
      if (!resolved) return { kind: "none" };
      touchUserSession(db, resolved.session, now());
      return { kind: "member", userId: resolved.user.id, sessionId: resolved.session.id, user: resolved.user };
    } catch {
      return { kind: "none" }; // fail closed: an unreadable database grants nothing
    }
  }

  return {
    home: opts.home,
    getDb: opts.getDb,
    authRequired: opts.authRequired,
    now,
    limiter: opts.limiter ?? globalHashLimiter,
    memberSockets,
    departmentExists(slug) {
      if (opts.knownDepartment) return opts.knownDepartment(slug);
      return !!opts.getDb().prepare("SELECT 1 FROM departments WHERE slug = ?").get(slug);
    },
    resolvePrincipal,
    boardsOf: (userId) => listGrantsForUser(opts.getDb(), userId),
    dispose: stopListening,
  };
}

/** For tests that want a private limiter (the process-wide one is shared across a test file). */
export { createHashLimiter };
