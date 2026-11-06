// What the signed-in person may do to one Todo. The operator may do everything the surface offers; a
// board member's authority is the role table in the board-members design, and the UI offers exactly
// that and no more. The gateway stays the authority: every write is checked there inside its own
// transaction, so a control shown here that the gateway refuses fails with the gateway's words.

import type { WorkItemTreeNodeWire } from "./api"
import type { BoardRole } from "./accounts-api"
import { GENERIC_MEMBER, memberIdOf } from "./accounts-api"

export interface TodoCapabilities {
  /** True when this is a board member's session; every flag below is then the member's own. */
  memberMode: boolean
  /** Comment, reply and attach. Edit or delete own comments follows from authorship. */
  comment: boolean
  attach: boolean
  /** Create sub-tasks (and root Todos on the board). */
  create: boolean
  /** Edit title, body and priority. Member-only trees only. */
  edit: boolean
  /** Mark done and reopen to backlog. Member-only trees only. */
  close: boolean
  /** Everything else on the page: pickers, assignment, dispatch, sessions, keep, runs. */
  operatorControls: boolean
}

export const OPERATOR_CAPABILITIES: TodoCapabilities = {
  memberMode: false,
  comment: true,
  attach: true,
  create: true,
  edit: true,
  close: true,
  operatorControls: true,
}

/** A member-only tree: every Todo in it (root included) was created by a person, none is assigned,
 *  and none has been put to work. The tree wire carries no session link, so a status an agent
 *  reaches (executing, in review, blocked, cancelled) stands in for "an agent has been here";
 *  the gateway checks the real condition on each write. */
export function isMemberOnlyTree(root: WorkItemTreeNodeWire | undefined): boolean {
  if (!root) return false
  const only = (node: WorkItemTreeNodeWire): boolean =>
    (memberIdOf(node.createdBy) !== null || node.createdBy === GENERIC_MEMBER)
    && !node.assignee
    && (node.status === "backlog" || node.status === "done")
    && (node.children ?? []).every(only)
  return only(root)
}

export function memberCapabilities(role: BoardRole | null | undefined, memberOnly: boolean): TodoCapabilities {
  const contributes = role === "collaborator" || role === "owner"
  return {
    memberMode: true,
    comment: contributes,
    attach: contributes,
    // A root Todo is created on the board; a sub-task only inside a member-only tree.
    create: contributes && memberOnly,
    edit: contributes && memberOnly,
    close: contributes && memberOnly,
    operatorControls: false,
  }
}

/** A tree the member created that has left their boards: they read it, and comment where a role of theirs allows comments, and
 *  that is all. Never an edit, a status change or a sub-task. */
export function movedCapabilities(canComment: boolean): TodoCapabilities {
  return { memberMode: true, comment: canComment, attach: canComment, create: false, edit: false, close: false, operatorControls: false }
}

export interface CommentPowers {
  reply: boolean
  edit: boolean
  remove: boolean
}

/** What the person may do to one comment. The operator edits their own and deletes anything; a
 *  member, where they may comment at all, edits and deletes only what they wrote. Authorship is the
 *  `user:` identity the gateway stamped, never the comment's kind. */
export function commentPowers(caps: TodoCapabilities, comment: { author: string; authorKind: string }, memberId: string | null): CommentPowers {
  if (!caps.memberMode) return { reply: true, edit: comment.authorKind === "operator", remove: true }
  const own = caps.comment && memberId !== null && comment.author === `user:${memberId}`
  return { reply: caps.comment, edit: own, remove: own }
}
