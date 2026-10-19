import { Pin } from "@/components/ui/icon"
import type { WorkItemCompactWire } from "@/lib/api"
import { departmentTitle } from "./board-switcher"

/* Keeping a Todo on Home, and saying whose work a kept Todo is.
 *
 * A pin is how anything the operator did not create reaches Home, so
 * both parts have to be legible from a board they did not pin: the pin says
 * "this can go on Home", and the caption says whose work the kept one is.
 *
 * Both parts are presentational — the mutation lives in use-board.ts with the
 * board's others, and reaches the card as a callback like every other action. */

/**
 * The toggle. It shows at rest wherever it is mounted — an affordance nobody can
 * see is one nobody uses — and any mount that wants it hover-gated says so in
 * the `className` it passes, as the four-row board card does: that card's
 * top row belongs to the assignee, and a pin resting beside every avatar reads
 * as state rather than as a control. Unkept it rests at `--text-tertiary`, which
 * clears 3:1 on the card in both themes where the quietest ink measured 1.9:1,
 * and strengthens under the pointer; kept it is the accent, filled. The button
 * occupies the same box in every state, so a card cannot resize as the pointer
 * crosses it.
 */
export function KeepToggle(
  { id, kept = false, onToggle, className = "" }:
  { id: string; kept?: boolean; onToggle: (vars: { id: string; kept: boolean }) => void; className?: string },
) {
  return (
    <button
      type="button"
      data-testid={`keep-toggle-${id}`}
      aria-pressed={kept}
      aria-label={kept ? `Kept on Home — remove ${id} from Home` : `Keep ${id} on Home`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle({ id, kept: !kept })
      }}
      className={[
        "focus-outline grid size-[22px] flex-none place-items-center rounded-md outline-none transition-colors duration-150",
        kept
          ? "text-[var(--accent)] hover:bg-[var(--accent-fill)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--text-secondary)]",
        className,
      ].join(" ")}
    >
      <Pin size={13} aria-hidden filled={kept} />
    </button>
  )
}

/** Whose work a kept Todo is — only when there is a department to name, so the
 *  line never reads `Kept · undefined`. Every kept Todo captions: `created_by`
 *  says nothing about who asked for it, so a Todo the operator
 *  "created" is no more theirs than one an agent raised. */
export function keptCaptionOf(item: WorkItemCompactWire): string | null {
  if (item.kept !== true || !item.department) return null
  return `Kept · ${departmentTitle(item.department)}`
}

export function KeptCaption({ item, className = "" }: { item: WorkItemCompactWire; className?: string }) {
  const caption = keptCaptionOf(item)
  if (!caption) return null
  return (
    <div
      data-testid={`kept-caption-${item.id}`}
      className={`flex items-center gap-1.5 text-[12px] text-[var(--text-quaternary)] ${className}`}
    >
      <Pin size={10} aria-hidden className="flex-none" />
      {caption}
    </div>
  )
}
