import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';

/**
 * How a board member is stamped on a Todo, a comment or an event.
 *
 * A member's writes are stored so that every reader that does not know about members grants them
 * nothing: comments as `system` authored by `user:<id>`, Todos as `connector` Todos created by
 * `user:<id>`, events with the `user:<id>` actor. The one thing that identifies a member is that
 * prefix on `created_by`, `author` or `actor`, never `source` or `author_kind` alone, which plugins
 * share. Every outward serialiser derives the distinct `member` kind from it.
 */

export const MEMBER_PREFIX = 'user:';

export function isMemberIdentity(identity: string | null | undefined): identity is string {
  return typeof identity === 'string' && identity.startsWith(MEMBER_PREFIX) && identity.length > MEMBER_PREFIX.length;
}

export function memberIdentity(userId: string): string {
  return `${MEMBER_PREFIX}${userId}`;
}

/** The user id a `user:<id>` identity names, or undefined for any other identity. */
export function memberIdOf(identity: string | null | undefined): string | undefined {
  return isMemberIdentity(identity) ? identity.slice(MEMBER_PREFIX.length) : undefined;
}

/** A member-created Todo's `source_ref`: unique per Todo (the `(source, source_ref)` index needs it), never a session. */
export function memberSourceRef(userId: string, nonce: string = randomUUID().replace(/-/g, '').slice(0, 12)): string {
  return `${MEMBER_PREFIX}${userId}:${nonce}`;
}

export const FORMER_MEMBER = 'Former member';

/** The name a member goes by, or "Former member" once the user is gone. Never throws. */
export function memberDisplayName(identity: string): string {
  const id = memberIdOf(identity);
  if (!id) return FORMER_MEMBER;
  try {
    const name = initDb().prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(id) as string | undefined;
    return name ?? FORMER_MEMBER;
  } catch {
    return FORMER_MEMBER;
  }
}

/** "<name> (board member)": how an agent reads a member's words, never as the operator's direction. */
export function memberLabel(identity: string): string {
  return `${memberDisplayName(identity)} (board member)`;
}

export type OutwardCommentKind = 'operator' | 'employee' | 'system' | 'member';

/** The kind a comment is shown as: `member` for a `user:` author, whatever it is stored as. */
export function outwardCommentKind(comment: { author: string; authorKind: string }): OutwardCommentKind {
  return isMemberIdentity(comment.author) ? 'member' : (comment.authorKind as OutwardCommentKind);
}

/** A comment as every outward serialiser shows it: same fields, with the member kind derived. */
export function outwardComment<T extends { author: string; authorKind: string }>(comment: T): Omit<T, 'authorKind'> & { authorKind: OutwardCommentKind } {
  return { ...comment, authorKind: outwardCommentKind(comment) };
}
