/* The Tree view's additions to a session row: indent guides, the fold toggle,
 * the count a folded parent shows, and the glyph that says why a top-level row
 * is top-level. Shared by the desktop and phone rows so the two cannot drift. */

import { Bot, ChevronRight, Repeat, Unlink } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TreeRootKind } from "@/components/chat/session-tree"

/** Per-row tree facts, supplied by the sidebar. Absent outside Tree view. */
export interface TreeRowMeta {
  /** 0 for a root; uncapped. */
  depth: number
  hasChildren: boolean
  collapsed: boolean
  /** Every session below this row, at any depth. */
  descendantCount: number
  /** Roots only: why this row is top-level. */
  rootKind?: TreeRootKind
  /** A root nobody typed into: a connector or plugin started it. */
  dispatchedRoot?: boolean
  /** What a folded parent is hiding, so an errored, busy or unread child is not lost. */
  hiddenSignal?: HiddenTreeSignal
  onToggle: (sessionId: string) => void
}

type Variant = "desktop" | "mobile"

export type HiddenTreeSignal = "error" | "running" | "unread" | null

const HIDDEN_HINT: Record<NonNullable<HiddenTreeSignal>, string> = {
  error: ", one recently failed",
  running: ", one still working",
  unread: ", some unread",
}

// A phone gets a wider step (its fold toggle is a full touch target) but fewer
// levels, so a deep chain still leaves the title most of a narrow row. `inset`
// is the row's own left padding in Tree view: the fold arrow is the leading
// element, so it sits near the edge rather than behind the flat row's padding.
const LAYOUT: Record<Variant, { step: number; maxDepth: number; toggle: number; inset: number }> = {
  desktop: { step: 12, maxDepth: 6, toggle: 16, inset: 4 },
  mobile: { step: 16, maxDepth: 3, toggle: 28, inset: 6 },
}

/** The row's left padding for its depth: the inset plus the capped indent. */
export function treeRowPadding(depth: number, variant: Variant): number {
  const { step, maxDepth, inset } = LAYOUT[variant]
  return inset + Math.min(depth, maxDepth) * step
}

/** One hairline per ancestor level, centred on that ancestor's fold toggle, so
 *  a child reads as hanging from the row above it. */
export function TreeGuides({ depth, variant }: { depth: number; variant: Variant }) {
  const { step, maxDepth, toggle, inset } = LAYOUT[variant]
  const levels = Math.min(depth, maxDepth)
  if (levels === 0) return null
  return (
    <>
      {Array.from({ length: levels }, (_, level) => (
        <span
          key={level}
          aria-hidden
          data-tree-guide
          className="pointer-events-none absolute inset-y-0 w-px bg-[var(--separator)]"
          style={{ left: inset + level * step + toggle / 2 }}
        />
      ))}
    </>
  )
}

/** Fold/unfold control, or a same-width spacer on a leaf so titles align. */
export function TreeToggle({
  sessionId,
  title,
  meta,
  variant,
}: {
  sessionId: string
  title: string
  meta: TreeRowMeta
  variant: Variant
}) {
  const { toggle } = LAYOUT[variant]
  if (!meta.hasChildren) {
    return <span aria-hidden className={cn("shrink-0", variant === "mobile" && "-mr-2")} style={{ width: toggle }} />
  }
  const label = `${meta.collapsed ? "Expand" : "Collapse"} ${title} (${meta.descendantCount} nested)`
  return (
    <button
      type="button"
      draggable={false}
      aria-expanded={!meta.collapsed}
      aria-label={label}
      title={label}
      data-tree-toggle={sessionId}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        meta.onToggle(sessionId)
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground",
        // The phone toggle is a full-height touch target; pull the row's gap
        // back in so it does not also push the avatar a gap further right.
        variant === "mobile" ? "-mr-2 h-11" : "h-5",
      )}
      style={{ width: toggle }}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
          !meta.collapsed && "rotate-90",
        )}
      />
    </button>
  )
}

const ROOT_MARKERS: Record<"orphan" | "cycle" | "dispatched", { Icon: typeof Bot; label: string; tip: string; tone: string }> = {
  orphan: {
    Icon: Unlink,
    label: "Orphaned: parent session not in this list",
    tip: "Spawned by a session that isn't in this list (archived, deleted, or not loaded yet)",
    tone: "text-[var(--system-orange)]",
  },
  cycle: {
    Icon: Repeat,
    label: "Parent chain loops back on itself",
    tip: "Its parent chain loops back on itself, so it is shown here instead",
    tone: "text-[var(--system-orange)]",
  },
  dispatched: {
    Icon: Bot,
    label: "Started automatically",
    tip: "Started automatically, not by you",
    tone: "text-[var(--text-tertiary)]",
  },
}

function rootMarkerKey(meta: TreeRowMeta): keyof typeof ROOT_MARKERS | null {
  if (meta.rootKind === "orphan" || meta.rootKind === "cycle") return meta.rootKind
  return meta.dispatchedRoot ? "dispatched" : null
}

/** Why a top-level row is top-level, when that is not "the operator started it".
 *  Deep rows past the indent cap also say how deep they really are. */
export function TreeMarker({ meta, variant }: { meta: TreeRowMeta; variant: Variant }) {
  const key = rootMarkerKey(meta)
  const marker = key ? ROOT_MARKERS[key] : null
  const beyondCap = meta.depth > LAYOUT[variant].maxDepth
  if (!marker && !beyondCap) return null
  return (
    <>
      {beyondCap ? (
        <span
          title={`Nested ${meta.depth} levels deep`}
          data-tree-deep
          className="shrink-0 text-caption2 tabular-nums text-[var(--text-quaternary)]"
        >
          L{meta.depth}
        </span>
      ) : null}
      {marker ? (
        <span
          role="img"
          aria-label={marker.label}
          title={marker.tip}
          data-tree-marker={key}
          className={cn("flex shrink-0 items-center", marker.tone)}
        >
          <marker.Icon aria-hidden className="size-3" />
        </span>
      ) : null}
    </>
  )
}

/** A folded parent's hidden count, tinted when something under it is live. */
export function TreeCollapsedCount({ meta }: { meta: TreeRowMeta }) {
  if (!meta.collapsed || meta.descendantCount === 0) return null
  const n = meta.descendantCount
  const hint = meta.hiddenSignal ? HIDDEN_HINT[meta.hiddenSignal] : ""
  return (
    <span
      title={`${n} nested ${n === 1 ? "session" : "sessions"} hidden${hint}`}
      data-tree-count
      className={cn(
        "flex h-[18px] shrink-0 items-center gap-1 rounded-full px-1.5 text-caption2 tabular-nums",
        meta.hiddenSignal === "error"
          ? "bg-[color-mix(in_srgb,var(--system-red)_14%,transparent)] text-[var(--system-red)]"
          : meta.hiddenSignal
            ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]"
            : "bg-[var(--fill-secondary)] text-[var(--text-tertiary)]",
      )}
    >
      {meta.hiddenSignal === "running" ? (
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      ) : null}
      {n}
    </span>
  )
}

/** The leading tree column of a row: ancestor guides, then the fold toggle. */
export function TreeLead({
  sessionId,
  title,
  meta,
  variant,
}: {
  sessionId: string
  title: string
  meta: TreeRowMeta
  variant: Variant
}) {
  return (
    <>
      <TreeGuides depth={meta.depth} variant={variant} />
      <TreeToggle sessionId={sessionId} title={title} meta={meta} variant={variant} />
    </>
  )
}
