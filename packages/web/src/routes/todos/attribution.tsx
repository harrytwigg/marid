import type { ReactNode } from "react"
import type { Employee, WorkItemCommentWire, WorkItemEventWire } from "@/lib/api"
import { memberIdOf } from "@/lib/accounts-api"
import { commentAuthorLabel } from "@/lib/todos"
import { useMember } from "@/hooks/use-principal"
import { EmployeeAvatar, OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { identityLabel, useResolvedIdentity } from "@/hooks/use-people-directory"
import { displayNameOf, memberActorWord, type Viewer } from "./util"
import { SessionActor } from "./task-page/session-ref"

/* A board member shown where a Todo says who did something. Members are stamped `user:<id>` on
 * comments, events and `createdBy`; they render as a HumanAvatar and their display name, never as
 * the operator or a system actor. The directory is read only inside the member components below,
 * so a surface with no member on it (every surface of an instance without accounts) never asks. */

/** Who is reading. The operator reads their own hand as "You"; a board member reading the same comment, audit line or
 *  creator reads "Operator", and the generic `agent` / `system` actors their reads carry as "Agent" / "System". */
export function useViewer(): Viewer {
  return useMember() ? "member" : "operator"
}

export function isMemberIdentity(identity: string | null | undefined): boolean {
  return memberIdOf(identity) !== null
}

export function isMemberComment(comment: Pick<WorkItemCommentWire, "authorKind" | "author">): boolean {
  return comment.authorKind === "member" || isMemberIdentity(comment.author)
}

/** The person's badge. While the directory has not answered it is an empty badge of the same size:
 *  a guess would flash a wrong name, and the layout should not move when the answer lands. */
export function MemberAvatar({ identity, size = 18 }: { identity: string; size?: number }) {
  const resolved = useResolvedIdentity(identity)
  if (resolved.kind === "pending") {
    return (
      <span
        aria-hidden
        data-testid="human-avatar-pending"
        className="inline-block shrink-0 bg-[var(--fill-secondary)]"
        style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
      />
    )
  }
  return resolved.kind === "member"
    ? <HumanAvatar name={resolved.displayName} initials={resolved.initials} size={size} />
    : <HumanAvatar name={identityLabel(resolved)} initials="?" size={size} />
}

export function MemberName({ identity }: { identity: string }) {
  return <>{identityLabel(useResolvedIdentity(identity))}</>
}

/** Avatar then name, the one-line form for a creator or a toucher. */
export function MemberChip({ identity, size = 14, className }: { identity: string; size?: number; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      <MemberAvatar identity={identity} size={size} />
      <span className="truncate"><MemberName identity={identity} /></span>
    </span>
  )
}

/** Operator comments avatar as the reserved "operator" actor, not an employee. */
export function CommentAvatar({ comment }: { comment: WorkItemCommentWire }) {
  if (isMemberComment(comment)) return <MemberAvatar identity={comment.author} size={18} />
  const operator = comment.authorKind === "operator"
  return (
    <EmployeeAvatar
      name={operator ? "operator" : comment.author}
      fallback={operator ? OPERATOR_DEFAULT_EMOJI : undefined}
      size={18}
      fontSize={10}
      className="bg-[var(--fill-secondary)]"
    />
  )
}

export function CommentAuthor({ comment, byName }: { comment: WorkItemCommentWire; byName: Map<string, Employee> }) {
  const viewer = useViewer()
  if (comment.authorKind === "operator") return <>{viewer === "member" ? "Operator" : "You"}</>
  if (isMemberComment(comment)) return <MemberName identity={comment.author} />
  const word = memberActorWord(comment.author, viewer)
  if (word) return <>{word}</>
  const label = comment.authorKind === "employee" ? displayNameOf(comment.author, byName) : commentAuthorLabel(comment.author, comment.authorKind)
  return <SessionActor actor={comment.author} byName={byName}>{label}</SessionActor>
}

/** The actor of an audit line. `children` is what a non-member actor reads as. */
export function EventActor({ actor, byName, children }: { actor: string | null; byName: Map<string, Employee>; children: ReactNode }) {
  if (!actor || !isMemberIdentity(actor)) return <SessionActor actor={actor} byName={byName}>{children}</SessionActor>
  return <MemberChip identity={actor} />
}

/** A member-created Todo's birth event names `connector` as its actor (the store records the source);
 *  the person is `createdBy`. Read it as the person, so the first line of the trail is theirs. */
export function withCreatorActor(events: WorkItemEventWire[], createdBy: string | undefined): WorkItemEventWire[] {
  if (!createdBy || !isMemberIdentity(createdBy)) return events
  return events.map((event) =>
    event.kind === "created" && !isMemberIdentity(event.actor) ? { ...event, actor: createdBy } : event)
}

/** The most recent member to write on a Todo, from its audit trail; null when the last hand was not a member's. */
export function lastMemberToucher(events: WorkItemEventWire[]): string | null {
  const last = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return last?.actor && isMemberIdentity(last.actor) ? last.actor : null
}

/** "· last touched by <name>" on the Todo page, only when the newest audit line is a member's. */
export function LastTouchedBy({ events }: { events: WorkItemEventWire[] }) {
  const toucher = lastMemberToucher(events)
  if (!toucher) return null
  return (
    <span data-testid="last-touched-by" className="text-[12px] font-normal text-[var(--text-quaternary)]">
      · last touched by <MemberName identity={toucher} />
    </span>
  )
}

/** Where an unassigned member-made Todo came from. It is stored as a connector's, so the source alone
 *  would read "Connector"; it reads as the person instead. */
export function MemberProvenance({ identity }: { identity: string }) {
  return <MemberChip identity={identity} className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]" />
}
