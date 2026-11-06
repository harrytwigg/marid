import type { Database as DatabaseType } from "better-sqlite3";
import { listGrantsForUser } from "./board-members.js";
import { memberFrameFor, readTodoChange, type TodoChange } from "./member-feed.js";
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

interface RegistryDeps {
  getDb: () => DatabaseType;
  authRequired: () => boolean;
  now?: () => number;
}

/** The user a session belongs to while it is valid, else undefined. Read on every use: nothing is cached. */
function validUser(deps: RegistryDeps, sessionId: string): string | undefined {
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
}

/** What one broadcast event is to every socket: read once, with each member's boards read once however many sockets they hold. */
interface Offer {
  change: TodoChange;
  boardsOf: Map<string, Set<string>>;
}

/** The frame a member's socket is sent for a broadcast event, serialised, or undefined when it hears nothing of it. */
function frameFor(deps: RegistryDeps, userId: string, offer: Offer): string | undefined {
  let boards = offer.boardsOf.get(userId);
  if (!boards) {
    boards = new Set(listGrantsForUser(deps.getDb(), userId).map((grant) => grant.department));
    offer.boardsOf.set(userId, boards);
  }
  const frame = memberFrameFor(offer.change, boards);
  return frame ? JSON.stringify({ ...frame, ts: (deps.now ?? Date.now)() }) : undefined;
}

/**
 * Member `/ws` sockets, each tied to its user session. They are not in the general broadcast's client set:
 * the broadcast hands every event to `publish`, which sends a socket only the re-serialised Todo frames
 * for its member's boards (`member-feed.ts`). A socket dies with its session.
 */
export function createMemberSocketRegistry(deps: RegistryDeps): MemberSocketRegistry {
  const sockets = new Map<MemberSocketLike, string>();
  const closeSocket = (socket: MemberSocketLike): void => {
    sockets.delete(socket);
    try { socket.close(MEMBER_SOCKET_CLOSE_UNAUTHORIZED, "unauthorized"); } catch { /* already closing */ }
  };
  /** Re-check one socket's session, then send it what it may hear of this event; a socket that cannot be checked or filtered is closed. */
  const deliver = (socket: MemberSocketLike, sessionId: string, offer: Offer): void => {
    const userId = validUser(deps, sessionId);
    if (userId === undefined) return closeSocket(socket);
    if (socket.readyState !== 1) return;
    try {
      const frame = frameFor(deps, userId, offer);
      if (frame) socket.send(frame);
    } catch {
      closeSocket(socket);
    }
  };
  return {
    add: (socket, sessionId) => { sockets.set(socket, sessionId); },
    remove: (socket) => { sockets.delete(socket); },
    size: () => sockets.size,
    sweep() {
      let closed = 0;
      for (const [socket, sessionId] of [...sockets]) {
        if (validUser(deps, sessionId) === undefined) { closeSocket(socket); closed += 1; }
      }
      return closed;
    },
    publish(event, payload) {
      if (sockets.size === 0) return;
      const change = readTodoChange(event, payload);
      if (!change) return;
      const offer: Offer = { change, boardsOf: new Map() };
      for (const [socket, sessionId] of [...sockets]) deliver(socket, sessionId, offer);
    },
    closeAll() {
      const all = [...sockets.keys()];
      for (const socket of all) closeSocket(socket);
      return all.length;
    },
  };
}
