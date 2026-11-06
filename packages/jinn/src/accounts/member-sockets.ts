import type { Database as DatabaseType } from "better-sqlite3";
import { getUserSession } from "./user-sessions.js";
import { getUserById } from "./users.js";

/** Closed with this code when the member's session is no longer valid, or accounts stop being honoured. */
export const MEMBER_SOCKET_CLOSE_UNAUTHORIZED = 4401;

export interface MemberSocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
}

export interface MemberSocketRegistry {
  add(socket: MemberSocketLike, sessionId: string): void;
  remove(socket: MemberSocketLike): void;
  /** Close every socket whose session is gone, expired, revoked or whose user is disabled; returns how many. */
  sweep(): number;
  /** Close every member socket, as a config reload turning gateway auth off does. */
  closeAll(): number;
  size(): number;
}

/**
 * Member `/ws` sockets, each tied to its user session. In this phase a member socket carries no board
 * data: it receives nothing the general broadcast sends (the broadcast never sees it), so the socket is
 * only a liveness channel until the member API's filtered, re-serialised frames arrive. What it must
 * already do is die with its session.
 */
export function createMemberSocketRegistry(deps: {
  getDb: () => DatabaseType;
  authRequired: () => boolean;
  now?: () => number;
}): MemberSocketRegistry {
  const sockets = new Map<MemberSocketLike, string>();
  const stillValid = (sessionId: string): boolean => {
    if (!deps.authRequired()) return false;
    try {
      const db = deps.getDb();
      const session = getUserSession(db, sessionId);
      const now = (deps.now ?? Date.now)();
      if (!session || session.revokedAt !== null || Date.parse(session.expiresAt) <= now) return false;
      return getUserById(db, session.userId)?.status === "active";
    } catch {
      return false; // fail closed
    }
  };
  const closeSocket = (socket: MemberSocketLike): void => {
    sockets.delete(socket);
    try { socket.close(MEMBER_SOCKET_CLOSE_UNAUTHORIZED, "unauthorized"); } catch { /* already closing */ }
  };
  return {
    add: (socket, sessionId) => { sockets.set(socket, sessionId); },
    remove: (socket) => { sockets.delete(socket); },
    size: () => sockets.size,
    sweep() {
      let closed = 0;
      for (const [socket, sessionId] of [...sockets]) {
        if (!stillValid(sessionId)) { closeSocket(socket); closed += 1; }
      }
      return closed;
    },
    closeAll() {
      const all = [...sockets.keys()];
      for (const socket of all) closeSocket(socket);
      return all.length;
    },
  };
}
