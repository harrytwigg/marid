import { MemberName } from "./attribution"

export const VISIBLE_TO_MEMBERS = "Visible to the members of this board"

const HINT_CLASS = "text-[calc(11px*var(--text-scale))] text-[var(--text-quaternary)]"

/** A small, quiet line: no popup, no dismissal. It tells whoever is writing that the people on this board read it. */
export function VisibleToMembersHint({ testId, className }: { testId: string; className?: string }) {
  return (
    <span data-testid={testId} className={`${HINT_CLASS} ${className ?? ""}`}>
      {VISIBLE_TO_MEMBERS}
    </span>
  )
}

/**
 * The operator's line on an open Todo a board member created: they read every comment and attachment on it wherever it now
 * sits, including a board with no members of its own and the company board, so an internal note written there reaches them.
 */
export function VisibleToCreatorHint({ identity, testId, className }: { identity: string; testId: string; className?: string }) {
  return (
    <span data-testid={testId} className={`${HINT_CLASS} ${className ?? ""}`}>
      Visible to <MemberName identity={identity} />, who created it
    </span>
  )
}
