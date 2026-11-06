export const VISIBLE_TO_MEMBERS = "Visible to the members of this board"

/** A small, quiet line: no popup, no dismissal. It tells whoever is writing that the people on this board read it. */
export function VisibleToMembersHint({ testId, className }: { testId: string; className?: string }) {
  return (
    <span data-testid={testId} className={`text-[calc(11px*var(--text-scale))] text-[var(--text-quaternary)] ${className ?? ""}`}>
      {VISIBLE_TO_MEMBERS}
    </span>
  )
}
