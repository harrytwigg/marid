import { memo, useCallback, useMemo } from "react"
import { ChevronRight } from "lucide-react"
import type { Employee, WorkItemCompactWire, WorkItemOpenDetailWire, WorkItemTreeWire } from "@/lib/api"
import { stateKeyOf } from "@/lib/todos"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { StateCircle } from "../state-glyph"
import { stopReasonOf } from "../util"
import { CardTree } from "./card-tree"
import { hasStopLead, StopCauseLead, stopLeadKey } from "./stop-cause"
import { KeepToggle } from "./keep-control"

/* ICI-1427 — the board card, Variant A: four rows, the same four on every card.
 * ID + assignee, status glyph + title, priority + labels + roll-up, cost + due.
 *
 * Every row is unconditional, so a card's height is settled by its title alone
 * and enrichment landing later cannot push the column around. The price, taken
 * knowingly: the escalation reason and the "Working · 21m"
 * line have no row of their own any more and live on the task page and in the
 * Needs-you view. The status the column used to carry alone is now also on the
 * card, as the glyph — it is what the lost red line escalated through. */

export interface CardEnrichment {
  tree?: WorkItemTreeWire
  detail?: WorkItemOpenDetailWire
}

/** Roll-up counts over all descendants (the mock's 2/5 = closed/total). */
export function rollupOf(tree: WorkItemTreeWire | undefined, rootStatus: string): { closed: number; total: number } | null {
  if (!tree) return null
  let total = 0
  let closed = 0
  for (const [status, count] of Object.entries(tree.totals)) {
    total += count ?? 0
    if (status === "done" || status === "cancelled") closed += count ?? 0
  }
  // The totals include the root itself — remove it.
  total -= 1
  if (rootStatus === "done" || rootStatus === "cancelled") closed -= 1
  if (total <= 0) return null
  return { closed, total }
}

/** The one-line why on blocked cards: the latest transition note. The
 *  card face has no row for it since Variant A; the Needs-you view still does. */
export function reasonOf(item: WorkItemCompactWire, detail: WorkItemOpenDetailWire | undefined): string | null {
  if (item.status !== "blocked") return null
  return stopReasonOf(detail?.events ?? [], item.status).note
}

/** Vertical anatomy used by the column FLIP dependency. Variant A's four rows
 *  all render unconditionally, so nothing enrichment brings — a cost, a set of
 *  bars, a roll-up chip — can change a card's height any more. What is left is
 *  the stop lead, and that arrives on the compact wire with the first paint. */
export function cardLayoutKey(item: WorkItemCompactWire, _enrichment: CardEnrichment | undefined): string {
  return stopLeadKey(item)
}

function formatDue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** Priority bars (polish law 14: bars ride 0.5px high). 3=High strong bars,
 *  1=Low first-bar-only. `muted` renders Medium too, which the board card wants:
 *  a row that disappears at the commonest priority is a row that changes height.
 *  The wire has no urgent level (0..3, spec §3.1). */
export function PriorityGlyph({ priority, muted = false }: { priority: number; muted?: boolean }) {
  if (priority === 2 && !muted) return null
  const strong = priority >= 3
  const low = priority <= 1
  const barColor = strong ? "var(--text-secondary)" : "var(--text-quaternary)"
  return (
    <span
      aria-hidden
      className="relative top-[-0.5px] flex flex-none items-end gap-[1.5px]"
      style={{ height: 10 }}
      data-testid="prio-bars"
      data-priority={priority}
    >
      {[4, 7, 10].map((h, i) => (
        <i
          key={h}
          className="block w-[2.5px] rounded-[1px]"
          style={{ height: h, background: barColor, opacity: low && i > 0 ? 0.35 : 1 }}
        />
      ))}
    </span>
  )
}

export interface BoardCardProps {
  item: WorkItemCompactWire
  enrichment?: CardEnrichment
  byName: Map<string, Employee>
  expanded: boolean
  onToggleTree: (id: string) => void
  onOpen: (id: string, item?: WorkItemCompactWire) => void
  onOpenChild: (id: string) => void
  onAddSubTask: (parentId: string, title: string) => void
  /** Keep this Todo on Home, or take it off. Absent = no keep affordance. */
  onKeep?: (vars: { id: string; kept: boolean }) => void
  /** Drag lift entry point (the drag hook owns pointer capture). */
  onLiftPointerDown?: (event: React.PointerEvent, item: WorkItemCompactWire) => void
  dragging?: boolean
  /** Rendered as the floating drag preview: lifted treatment, inert. */
  ghost?: boolean
}

export const BoardCard = memo(function BoardCard({
  item,
  enrichment,
  byName,
  expanded,
  onToggleTree,
  onOpen,
  onOpenChild,
  onAddSubTask,
  onKeep,
  onLiftPointerDown,
  dragging,
  ghost,
}: BoardCardProps) {
  const tree = enrichment?.tree
  const detail = enrichment?.detail
  const rollup = useMemo(() => rollupOf(tree, item.status), [tree, item.status])
  const priority = tree?.root.priority ?? detail?.workItem.priority ?? 2
  const spendUsd = tree?.spendUsd ?? 0
  const employee = item.assignee ? byName.get(item.assignee) : undefined
  const assigneeName = employee?.displayName ?? item.assignee
  const overdue = !!item.dueAt && Date.parse(item.dueAt) < Date.now()
  const addSubTask = useCallback((title: string) => onAddSubTask(item.id, title), [item.id, onAddSubTask])

  return (
    <article
      data-board-card={item.id}
      data-testid={`board-card-${item.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${item.id} ${item.title}`}
      onClick={() => onOpen(item.id, item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) onOpen(item.id, item)
      }}
      onPointerDown={(e) => onLiftPointerDown?.(e, item)}
      className={[
        // A phone card never skips its render: an estimated height moved the container's scrollHeight 2721 → 3981 mid-commit and scroll anchoring chased it to an edge. Desktop keeps skipping, at a fixed intrinsic size rather than `auto`, which remembers each card's last rendered height and revises it mid-scroll (8129 → 6112).
        "group focus-ring flex cursor-pointer select-none flex-col gap-2 rounded-[var(--radius-lg)] p-3 outline-none transition-colors duration-150 [content-visibility:auto] [contain-intrinsic-size:137px] max-[700px]:[content-visibility:visible] max-[700px]:[contain-intrinsic-size:auto]",
        ghost
          ? "bg-[var(--bg-tertiary)] shadow-[var(--shadow-overlay)]"
          : "bg-[var(--bg-secondary)] shadow-[var(--shadow-ambient),var(--shadow-subtle),var(--inset-shine)] hover:bg-[var(--bg-tertiary)]",
        ghost ? "" : "max-[700px]:rounded-xl max-[700px]:bg-transparent max-[700px]:shadow-none max-[700px]:hover:bg-[var(--fill-quaternary)]",
        dragging ? "opacity-0" : "",
      ].join(" ")}
    >
      {hasStopLead(item) && <StopCauseLead item={item} />}

      {/* Row 1 — which Todo, and whose. The row is as tall as the ID's own line
       *  rather than as tall as the avatar: centring 11px text inside a 20px
       *  disc pushes it 6px below the inset the left edge sets, which is the
       *  top-heaviness this face exists to fix. The disc overflows the row
       *  evenly instead, so the ID's gap from the top reads as its gap from the
       *  left. */}
      <div className="flex h-3.5 items-center gap-2">
        <span
          className="leading-none tracking-[.04em] text-[calc(11px*var(--text-scale))] text-[var(--text-tertiary)]"
          style={{ fontFamily: "var(--font-code)" }}
        >
          {item.id}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {/* Hover-revealed here alone: the resting face is a fixed grid, and a
           *  pin at rest in the row the avatar owns competes with it on every
           *  card. The list row and the task page still show it at rest. */}
          {onKeep && !ghost && (
            <KeepToggle
              id={item.id}
              kept={item.kept}
              onToggle={onKeep}
              className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
            />
          )}
          {item.assignee && (
            <span title={assigneeName ?? undefined} className="flex-none">
              <EmployeeAvatar name={item.assignee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
            </span>
          )}
        </span>
      </div>

      {/* Row 2 — the state, then the only primary ink on the card. */}
      <div className="flex items-start gap-2">
        <StateCircle keyOf={stateKeyOf(item.status)} size={16} className="mt-[2px] flex-none" />
        <div className="line-clamp-2 min-w-0 text-[calc(15px*var(--text-scale))] font-medium leading-[1.3] text-[var(--text-primary)] max-[700px]:line-clamp-1 max-[700px]:text-[calc(16px*var(--text-scale))]">
          {item.title}
        </div>
      </div>

      {/* Row 3 — priority, labels, roll-up. Fixed height so a chip arriving with
       *  enrichment fills the row instead of growing it.
       *
       *  The labels are what yield when the row runs out of width, never the
       *  roll-up: it is the only way into the sub-task tray from the board, and
       *  a third label in a 240px column pushed it clean past the row's clipped
       *  edge — still in the DOM, zero pixels wide, unclickable. Ornament
       *  truncates; the control keeps its intrinsic width. */}
      <div className="flex h-5 items-center gap-[5px] overflow-hidden">
        <PriorityGlyph priority={priority} muted />
        {item.labels?.map((label) => (
          <span
            key={label.id}
            className="flex h-5 min-w-0 items-center gap-[5px] rounded-[10px] bg-[var(--fill-tertiary)] px-2 text-[calc(11px*var(--text-scale))] font-medium text-[var(--text-secondary)]"
          >
            <span className="size-[5px] flex-none rounded-full" style={{ background: label.color ?? "var(--text-quaternary)" }} />
            <span className="truncate">{label.name}</span>
          </span>
        ))}
        {rollup && (
          <button
            type="button"
            data-testid={`board-rollup-${item.id}`}
            aria-expanded={expanded}
            aria-label={`${rollup.closed} of ${rollup.total} sub-tasks done — ${expanded ? "collapse" : "expand"}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleTree(item.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="focus-ring flex h-5 flex-none items-center gap-1 rounded-[10px] bg-[var(--fill-tertiary)] py-0 pl-[5px] pr-2 text-[calc(11px*var(--text-scale))] font-medium tabular-nums text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)]"
          >
            <ChevronRight
              size={10}
              aria-hidden
              className={`text-[var(--text-quaternary)] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            />
            {rollup.closed}/{rollup.total}
          </button>
        )}
      </div>

      {/* Row 4 — what it has cost, and when it is due. The cost renders at $0.00
       *  too: a row that only some cards have is a row that changes heights. */}
      <div className="flex items-center gap-2 text-[calc(11px*var(--text-scale))]">
        <span className="tabular-nums text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          ${spendUsd.toFixed(2)}
        </span>
        {item.dueAt && (
          <span className={`ml-auto ${overdue ? "text-[var(--system-red)]" : "text-[var(--text-tertiary)]"}`}>
            {formatDue(item.dueAt)}
          </span>
        )}
      </div>

      {/* In-place tree tray. */}
      {expanded && tree && (
        <CardTree
          tree={tree}
          cardDepth={item.depth ?? 0}
          onOpenChild={onOpenChild}
          onAddSubTask={addSubTask}
        />
      )}
    </article>
  )
})
