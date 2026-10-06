import React from "react"
import { Pin } from "lucide-react"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { SessionDepartmentBadge } from "@/components/session-department-badge"
import { cleanPreview } from "@/lib/clean-preview"
import { cn } from "@/lib/utils"
import { ACTION_WIDTH, MobileRowMenu, SwipeActionRails, type RowActions } from "@/components/chat/mobile-row-actions"
import { SessionSelectCheckbox } from "@/components/chat/session-row-menu"
import {
  formatTime,
  getSessionActivity,
  getStatusDot,
  isArchivedSession,
  SessionAttentionChips,
  StatusDot,
  useStallClock,
  type Session,
} from "@/components/chat/session-signals"
import { useSwipeActions } from "@/components/chat/use-swipe-actions"
import { TreeCollapsedCount, TreeLead, TreeMarker, treeRowPadding, type TreeRowMeta } from "@/components/chat/session-tree-row"

export interface MobileSessionRowProps {
  session: Session
  /** Avatar slug — employee name, or the portal slug for direct chats. */
  avatarName: string
  /** Strong first line: employee display name, or the portal name. */
  displayName: string
  /** Rows inside the Pinned section drop the per-row pin glyph. */
  hidePin?: boolean
  /** Tree view only: indent, fold toggle and root marker. */
  tree?: TreeRowMeta
  selectedId: string | null
  readSessions: Set<string>
  pinnedSessions: Set<string>
  renamingSessionId: string | null
  renameCancelledRef: React.MutableRefObject<boolean>
  fixTitle: (title: string | undefined, employee: string | undefined) => string
  onSelect: (id: string) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  togglePin: (pinKey: string) => void
  handleDuplicate: (sessionId: string) => void
  handleStop: (sessionId: string) => void
  handleArchive: (session: Session) => void
  setDeleteTarget: (target: { type: "session" | "employee" | "bulk"; id: string; label: string; sessions?: Session[] } | null) => void
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  /** Multi-select: the row becomes a checkbox toggling membership in the batch. */
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}

interface SummaryProps {
  session: Session
  avatarName: string
  displayName: string
  title: string
  strong: boolean
  showPin: boolean
  isArchived: boolean
  readSessions: Set<string>
  tree?: TreeRowMeta
}

/** Avatar, then the two lines a phone list cell reads by — the chat TITLE is
 *  the strong line (it's what the operator scans to switch), the employee name
 *  the quiet one. Identity is already ambient in the emoji avatar. */
function RowSummary({ session, avatarName, displayName, title, strong, showPin, isArchived, readSessions, tree }: SummaryProps) {
  const stallNow = useStallClock(session.status === "running")
  const dot = getStatusDot(session, readSessions, false, stallNow)
  return (
    <>
      <span className="relative flex size-[30px] shrink-0 items-center justify-center">
        <EmployeeAvatar name={avatarName} size={30} />
        {dot ? (
          <StatusDot
            color={dot.color}
            pulse={dot.pulse}
            title={dot.label}
            className="absolute -bottom-0.5 right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-subheadline text-foreground",
              strong ? "font-[var(--weight-semibold)]" : "font-[var(--weight-regular)]",
            )}
          >
            {title}
          </span>
          {tree ? <TreeMarker meta={tree} variant="mobile" /> : null}
          {tree ? <TreeCollapsedCount meta={tree} /> : null}
          {isArchived ? <span className="shrink-0 text-caption2 font-[var(--weight-medium)] text-[var(--text-tertiary)]">Archived</span> : null}
          {showPin ? <Pin className="size-3 shrink-0 text-[var(--text-tertiary)]" /> : null}
          <span className="shrink-0 text-caption1 tabular-nums text-[var(--text-quaternary)]">
            {formatTime(getSessionActivity(session))}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-caption1 text-[var(--text-tertiary)]">{displayName}</span>
          <SessionAttentionChips session={session} />
          <SessionDepartmentBadge department={session.scopeDepartment} />
        </span>
      </span>
    </>
  )
}

/** Overlaid on the quiet line rather than replacing it: an input cannot live
 *  inside the row's own button. */
function RowRenameInput({
  title,
  cancelledRef,
  onCommit,
  onDone,
}: {
  title: string
  cancelledRef: React.MutableRefObject<boolean>
  onCommit: (next: string) => void
  onDone: () => void
}) {
  return (
    <input
      autoFocus
      maxLength={200}
      defaultValue={title}
      aria-label="Rename chat"
      className="absolute bottom-2.5 left-4 right-16 h-9 rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] px-2 text-footnote text-[var(--text-primary)] outline-none"
      onFocus={(e) => e.target.select()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        else if (e.key === "Escape") {
          cancelledRef.current = true
          onDone()
        }
      }}
      onBlur={(e) => {
        if (cancelledRef.current) {
          cancelledRef.current = false
          return
        }
        const next = e.target.value.trim()
        if (next && next !== title) onCommit(next)
        onDone()
      }}
    />
  )
}

/** The sliding half of the row: everything that rides on top of the action rails.
 *  Motion is transform-only and both ends of it come from the motion tokens, so a
 *  drag tracks the finger exactly and the release settles on the shared curve. */
function RowSurface({
  swipe,
  isActive,
  swipeEnabled = true,
  paddingLeft,
  children,
}: {
  swipe: ReturnType<typeof useSwipeActions>
  isActive: boolean
  /** Tree view: the row's inset for its depth. */
  paddingLeft?: number
  /** Selection mode turns the whole row into a checkbox, so the swipe gesture
   *  (and its rails) is off — one tap target, one meaning. */
  swipeEnabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      data-pressed={(swipeEnabled && swipe.pressing) || undefined}
      onPointerDown={swipeEnabled ? swipe.onPointerDown : undefined}
      onClickCapture={swipeEnabled ? swipe.onClickCapture : undefined}
      style={{
        // A rail left open when selection mode turns on must not keep the row
        // shifted: the transform follows the same switch as the gesture.
        transform: `translate3d(${swipeEnabled ? swipe.offset : 0}px, 0, 0)`,
        transitionProperty: "transform",
        transitionDuration: swipe.dragging ? "var(--duration-instant)" : "var(--duration-base)",
        transitionTimingFunction: "var(--ease-snappy)",
        touchAction: "pan-y pinch-zoom",
        paddingLeft,
      }}
      className={cn(
        "relative flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left data-[pressed]:bg-[var(--fill-primary)]",
        isActive ? "bg-[var(--fill-secondary)]" : "bg-[var(--sidebar-bg)]",
      )}
    >
      {children}
    </div>
  )
}

/** Every row action closes the rail first: leaving it open behind a dialog or a
 *  freshly pinned row is the state nobody expects. */
function rowActions(props: MobileSessionRowProps, swipe: ReturnType<typeof useSwipeActions>, title: string): RowActions {
  const { session, renameCancelledRef, setRenamingSessionId } = props
  return {
    onRename: () => { renameCancelledRef.current = false; setRenamingSessionId(session.id) },
    onTogglePin: () => { swipe.close(); props.togglePin(session.id) },
    onDuplicate: () => props.handleDuplicate(session.id),
    onArchive: () => { swipe.close(); props.handleArchive(session) },
    onStop: () => props.handleStop(session.id),
    onDelete: () => { swipe.close(); props.setDeleteTarget({ type: "session", id: session.id, label: title }) },
  }
}

/** The tappable body: opens the chat, or — in selection mode — toggles the row's
 *  membership in the batch. Extracted so MobileSessionRow stays under the
 *  function-length cap as selection mode grows. */
function MobileRowButton({ props, title, isSelected, onClick }: {
  props: MobileSessionRowProps
  title: string
  isSelected: boolean
  onClick: () => void
}) {
  const { session } = props
  const isActive = session.id === props.selectedId
  const isUnread =
    !props.readSessions.has(session.id) && session.status !== "running" && session.status !== "error"
  return (
    <button
      onClick={onClick}
      {...(props.selectionMode && {
        role: "checkbox",
        "aria-checked": isSelected,
        "aria-label": `Select ${title}`,
      })}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
    >
      {props.selectionMode ? <SessionSelectCheckbox checked={isSelected} /> : null}
      <RowSummary
        session={session}
        avatarName={props.avatarName}
        displayName={props.displayName}
        title={title}
        strong={isUnread || isActive}
        showPin={props.pinnedSessions.has(session.id) && !props.hidePin}
        isArchived={isArchivedSession(session)}
        readSessions={props.readSessions}
        tree={props.tree}
      />
    </button>
  )
}

// Tree rows set their own left padding; undefined leaves the class padding alone.
function treeInset(tree: TreeRowMeta | undefined): number | undefined {
  return tree ? treeRowPadding(tree.depth, "mobile") : undefined
}

/** The phone chat row: one comfortable list cell, avatar leading, name and time
 *  on the strong line, chat title on the quiet one. Swipe reveals the actions the
 *  desktop row already offers — Pin leading, Archive + Delete trailing — and the
 *  always-visible `⋯` keeps every one of them reachable without a gesture. */
export const MobileSessionRow = React.memo(function MobileSessionRow(props: MobileSessionRowProps) {
  const { session } = props
  const title = cleanPreview(props.fixTitle(session.title, session.employee)) || "Untitled"
  const isActive = session.id === props.selectedId
  const isPinned = props.pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isSelected = !!props.selectionMode && !!props.selectedIds?.has(session.id)
  const swipe = useSwipeActions({ leading: ACTION_WIDTH, trailing: ACTION_WIDTH * 2 })
  const actions = rowActions(props, swipe, title)

  const handleRowClick = () => {
    if (props.selectionMode) {
      props.onToggleSelect?.(session.id)
      return
    }
    // An open row spends its next tap dismissing itself, the way a native list
    // cell does — otherwise the only way back is a second swipe.
    if (swipe.openSide) {
      swipe.close()
      return
    }
    props.onSelect(session.id)
    props.onEmployeeSessionsAvailable?.([session])
  }

  return (
    <div data-row="mobile" className="relative overflow-hidden">
      {/* Selection mode owns the row's tap: a swipe rail would expose a second,
          contradictory action (per-row archive/delete) behind a gesture. */}
      {swipe.offset !== 0 && !props.selectionMode ? (
        <SwipeActionRails side={swipe.offset < 0 ? "trailing" : "leading"} isPinned={isPinned} isArchived={isArchived} {...actions} />
      ) : null}
      <RowSurface swipe={swipe} isActive={isActive} swipeEnabled={!props.selectionMode} paddingLeft={treeInset(props.tree)}>
        {props.tree ? <TreeLead sessionId={session.id} title={title} meta={props.tree} variant="mobile" /> : null}
        <MobileRowButton props={props} title={title} isSelected={isSelected} onClick={handleRowClick} />
        {props.renamingSessionId === session.id ? (
          <RowRenameInput
            title={title}
            cancelledRef={props.renameCancelledRef}
            onCommit={(next) => props.updateSessionTitle(session.id, next)}
            onDone={() => props.setRenamingSessionId(null)}
          />
        ) : null}
        {props.selectionMode ? null : (
          <MobileRowMenu session={session} isPinned={isPinned} isArchived={isArchived} {...actions} />
        )}
      </RowSurface>
    </div>
  )
})
