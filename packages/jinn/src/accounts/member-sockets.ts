import type { Database as DatabaseType } from "better-sqlite3";
import { listGrantsForUser } from "./board-members.js";
import { buildMemberFrame } from "./member-feed.js";
import { getUserSession } from "./user-sessions.js";
import { getUserById } from "./users.js";

/** Closed with this code when the member's session is no longer valid, or accounts stop being honoured. */
export const MEMBER_SOCKET_CLOSE_UNAUTHORIZED = 4401;

export interface MemberSocketLike {
  readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export interface MemberSocketRegistry {
  add(socket: MemberSocketLike, sessionId: string): void;
  remove(socket: MemberSocketLike): void;
  /** Close every socket whose session is gone, expired, revoked or whose user is disabled; returns how many. */
  sweep(): number;
  /** Close every member socket, as a config reload turning gateway auth off does. */
  closeAll(): number;
  /**
   * The one gateway broadcast, seen by member sockets: each socket's session is re-checked first (closed 4401 when it
   * is no longer valid), then it is sent a re-serialised frame for a Todo change on one of its boards, and nothing else.
   */
  publish(event: string, payload: unknown): void;
  size(): number;
}

/**
 * Member `/ws` sockets, each tied to its user session. They are not in the general broadcast's client set:
 * the broadcast hands every event to `publish`, which sends a socket only the re-serialised Todo frames
 * for its member's boards (`member-feed.ts`). A socket dies with its session.
 */
export function createMemberSocketRegistry(deps: {
  getDb: () => DatabaseType;
  authRequired: () => boolean;
  now?: () => number;
}): MemberSocketRegistry {
  const sockets = new Map<MemberSocketLike, string>();
  /** The user a session belongs to while it is valid, else undefined. Read on every use: nothing is cached. */
  const validUser = (sessionId: string): string | undefined => {
    if (!deps.authRequired()) return undefined;
    try {
      const db = deps.getDb();
      const session = getUserSession(db, sessionId);
      const now = (deps.now ?? Date.now)();
      if (!session || session.revokedAt !== null || Date.parse(session.expiresAt) <= now) return undefined;
      return getUserById(db, session.userId)?.status === "active" ? session.userId : undefined;
    } catch {
      return undefined; // fail closed
    }
  };
  const stillValid = (sessionId: string): boolean => validUser(sessionId) !== undefined;
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
    publish(event, payload) {
      if (sockets.size === 0 || event !== "company:changed") return;
      for (const [socket, sessionId] of [...sockets]) {
        const userId = validUser(sessionId);
        if (userId === undefined) { closeSocket(socket); continue; }
        if (socket.readyState !== 1) continue;
        try {
          const boards = new Set(listGrantsForUser(deps.getDb(), userId).map((grant) => grant.department));
          const frame = buildMemberFrame(event, payload, boards);
          if (frame) socket.send(JSON.stringify({ ...frame, ts: (deps.now ?? Date.now)() }));
        } catch {
          closeSocket(socket); // a socket that cannot be filtered is not sent anything
        }
      }
    },
    closeAll() {
      const all = [...sockets.keys()];
      for (const socket of all) closeSocket(socket);
      return all.length;
    },
  };
}
