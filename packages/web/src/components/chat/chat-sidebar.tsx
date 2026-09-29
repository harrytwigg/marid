
import React, { useEffect, useState, useRef, useCallback, useMemo, startTransition } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useQueryClient } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { Archive, CalendarClock, ChevronDown, ChevronRight, Clock3, EllipsisVertical, Focus, Layers, ListChecks, ListTree, Pin, Plus, Search, SquarePen, Trash2, Workflow as WorkflowIcon, X } from "lucide-react"
import { api, type Employee, type SessionsResponse } from "@/lib/api"
import { useOrg } from "@/hooks/use-employees"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { useSettings } from "@/routes/settings-provider"
import { cleanPreview } from "@/lib/clean-preview"
import { queryKeys } from "@/lib/query-keys"
import { useSessions, usePinnedSessions, useSessionCounts, useSessionSearch, useUpdateSession, useDeleteSession, useBulkDeleteSessions, useDuplicateSession, useArchiveSession, useUnarchiveSession, useStopSession } from "@/hooks/use-sessions"
import { usePins, useTogglePin } from "@/hooks/use-pins"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  getReadSessions,
  loadExpandedState,
  loadTreeCollapsed,
  markAllReadForEmployee,
  markSessionRead,
  saveExpandedState,
  saveTreeCollapsed,
} from "@/components/chat/chat-sidebar-prefs"
import { buildSessionForest, flattenSessionForest, subtreeSessions, type SessionTreeNode, type SessionTreeRow } from "@/components/chat/session-tree"
import { Slot } from "@/contrib/slot"
import { AREAS } from "@/contrib/types"
import { mergeSidebarEmployees, bucketByDay, isFocusedSession } from "@/components/chat/chat-route-helpers"
import { TerminalSectionHeader, useTerminalHosts } from "@/components/chat/sidebar-terminals"
import { isTerminalSession } from "@/lib/terminal-session"
import { TERMINAL_AVATAR } from "@/components/ui/employee-avatar"
import { MobileSessionRow } from "@/components/chat/mobile-session-row"
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
import {
  SESSION_MENU_CONTENT_CLASS,
  SESSION_MENU_ITEM_CLASS,
  SESSION_MENU_SEPARATOR_CLASS,
  SessionRowMenu,
  SessionSelectCheckbox,
  workflowRunPath,
} from "@/components/chat/session-row-menu"
import { chatSessionDragProps } from "@/routes/chat/chat-session-dnd"
import { TreeCollapsedCount, TreeLead, TreeMarker, treeRowPadding, type HiddenTreeSignal, type TreeRowMeta } from "@/components/chat/session-tree-row"
import type { ChatSidebarProps } from "@/components/chat/chat-sidebar-types"
import { PRODUCT_NAME } from "@/lib/brand"

export type { SidebarOrder } from "@/components/chat/chat-sidebar-types"

interface FlatItem {
  type: "employee" | "direct"
  employeeName?: string
  employeeData?: Employee
  sessions?: Session[]
  session?: Session
  sortKey: string
  pinKey: string
  /** Server group key for "load more" (employee slug, or a sentinel). */
  groupKey?: string
  /** True total in this group (may exceed loaded `sessions.length`). */
  total?: number
}

// One flat session row (Today / Yesterday / search results), carrying the
// resolved employee identity so the row can render without re-deriving it.
interface FlatRow {
  session: Session
  avatarName: string
  displayName: string
}

// Server-side group sentinels — must match CRON_GROUP/DIRECT_GROUP in the
// backend registry (sessions are bounded per group; "load more" fetches the rest).
const DIRECT_GROUP = "__direct__"
const CRON_GROUP = "__cron__"
const TERMINAL_GROUP = "__terminal__"

const OLDER_EXPANDED_STORAGE_KEY = "jinn-sidebar-older-expanded"
const PINNED_EXPANDED_STORAGE_KEY = "jinn-sidebar-pinned-expanded"
const FOCUS_MODE_STORAGE_KEY = "jinn-sidebar-focus-mode"
const EMPTY_PINNED_SESSIONS = new Set<string>()

/** Pinned rows shown before the section folds behind "N more pinned" — a long
 *  pin list must never push Today off the first screen. */
export const PINNED_VISIBLE = 5

// Tree shows what All shows, with each spawned session nested under the one
// that started it instead of as its own flat row.
type FocusMode = "focused" | "all" | "tree"

// One visible Tree view row: the flat row's resolved identity plus where it
// sits in the forest.
interface TreeVisibleRow {
  row: FlatRow
  tree: SessionTreeRow
  hiddenSignal: HiddenTreeSignal
}

/** The loudest signal among the sessions a folded parent hides, in the order
 *  the row dot itself ranks them: a fresh error, then live work (running,
 *  stalled or background), then unread. */
export function hiddenTreeSignal(hidden: readonly Session[], readSessions: Set<string>, now = Date.now()): HiddenTreeSignal {
  let signal: HiddenTreeSignal = null
  for (const session of hidden) {
    const dot = getStatusDot(session, readSessions, false, now)
    if (!dot) continue
    if (dot.label === "error") return "error"
    if (dot.label !== "unread") signal = "running"
    else if (!signal) signal = "unread"
  }
  return signal
}

// Selection order is of rendered rows, not ids (see selectableRowOrder).
type SelectableRowKind = "flat" | "tree"
const rowKey = (kind: SelectableRowKind, id: string) => `${kind}:${id}`
const rowKeyId = (key: string) => key.slice(key.indexOf(":") + 1)

// Session keys the gateway gives sessions it starts on its own: a Todo
// dispatch, a capture being shaped, a delegation. These are recorded with
// source "web" like a typed chat, so the source alone cannot tell them apart.
const DISPATCHED_SOURCE_REF = /^(todo-dispatcher|todo-shaper|delegation):/

/** A top-level session the operator did not start by typing into it: a system
 *  employee's run, a gateway-dispatched session, or any source the Focused
 *  filter already treats as automated. Workflow runs are left out because
 *  their own chip already says so. Tree view only; Focused is unchanged. */
export function isDispatchedRoot(
  s: Pick<Session, "source" | "sourceRef" | "employee" | "parentSessionId">,
  employeeData: Map<string, Employee>,
): boolean {
  if (s.source === "workflow") return false
  if (!isFocusedSession(s)) return true
  if (s.employee && employeeData.get(s.employee)?.system) return true
  return DISPATCHED_SOURCE_REF.test(String(s.sourceRef ?? ""))
}

function titleCase(slug: string | null | undefined): string {
  if (!slug) return ""
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

/** Resolve the avatar slug + human label for a flat session row. Direct/COO
 *  sessions borrow the portal identity; cron/employee-less sessions fall back to
 *  it too — they have no org employee, so search (which flattens cron rows that
 *  the grouped view renders separately) must not `.split()` a null employee.
 *  The rest use their employee's org profile. */
export function resolveRowIdentity(
  s: Pick<Session, "source" | "sourceRef" | "employee"> & { engine?: unknown },
  opts: { portalSlug: string; portalName: string; employeeData: Map<string, Employee> },
): { avatarName: string; displayName: string } {
  const { portalSlug, portalName, employeeData } = opts
  if (isTerminalSession(s)) return { avatarName: TERMINAL_AVATAR, displayName: "Terminal" }
  if (isDirectSession(s, portalSlug) || !s.employee) {
    return { avatarName: portalSlug, displayName: portalName }
  }
  const emp = s.employee
  return { avatarName: emp, displayName: employeeData.get(emp)?.displayName || titleCase(emp) }
}

function isCronSession(session: Pick<Session, "source" | "sourceRef">): boolean {
  return session.source === "cron" || (session.sourceRef || "").startsWith("cron:")
}

/** Pinned chats float to a dedicated Pinned section at the top of the list,
 *  regardless of recency bucket, focus mode, or source (a pin is explicit
 *  intent). Cron sessions float too — the sidebar no longer paginates a
 *  Scheduled group (that moved to the Cron page), so the old offset-math
 *  exemption is gone. */
export function shouldFloatPinned(
  s: Pick<Session, "id" | "source" | "sourceRef">,
  pinned: Set<string>,
): boolean {
  return pinned.has(s.id)
}

export function isDirectSession(
  session: Pick<Session, "source" | "sourceRef" | "employee">,
  portalSlug?: string,
): boolean {
  if (isCronSession(session)) return false
  if (!session.employee) return true
  // A session tagged with the portal slug is a direct/COO session, not a
  // pseudo-employee — fold it into the direct group rather than a phantom one
  // that renders with the portal's own title.
  return !!portalSlug && session.employee.toLowerCase() === portalSlug
}

// Sources the sidebar renders (others, e.g. slack/telegram, are shown elsewhere).
export function isVisibleSource(s: Pick<Session, "source">): boolean {
  return s.source === "web" || s.source === "terminal" || s.source === "talk" || s.source === "cron" || s.source === "workflow" || s.source === "plugin" || s.source === "whatsapp" || s.source === "discord" || !s.source
}

export function WorkflowSessionChip({
  session,
}: {
  session: Pick<Session, "source" | "sourceRef">
}) {
  if (session.source !== "workflow") return null
  const path = workflowRunPath(session.sourceRef)
  if (!path) {
    return (
      <span
        role="img"
        aria-label="Workflow session"
        className="flex size-[18px] shrink-0 items-center justify-center text-[var(--system-indigo)]"
      >
        <WorkflowIcon aria-hidden className="size-3.5" />
      </span>
    )
  }
  return (
    <Link
      to={path}
      onClick={(event) => event.stopPropagation()}
      aria-label="Open workflow run"
      className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--system-indigo)_12%,transparent)] text-[var(--system-indigo)] transition-colors hover:bg-[color-mix(in_srgb,var(--system-indigo)_20%,transparent)]"
      title="Open workflow run"
    >
      <WorkflowIcon aria-hidden className="size-3.5" />
    </Link>
  )
}

export { pickDeleteFallbackId, pickNeighborSessionId } from "@/components/chat/session-delete-fallback"

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => getSessionActivity(b).localeCompare(getSessionActivity(a)))
}

// One quiet, unified treatment for every sidebar section header
// (Today/Yesterday, Older, Scheduled, Team): muted medium label with light
// tracking and the count as a plain trailing number — no shouty uppercase, no
// filled chip. Keep these constants the single source so the headers can't drift.
const SECTION_LABEL_CLASS =
  "text-caption2 font-[var(--weight-medium)] tracking-[0.06em] text-[var(--text-tertiary)]"
const SECTION_COUNT_CLASS = "text-caption2 tabular-nums text-[var(--text-quaternary)]"

function SectionLabel({
  label,
  count,
}: {
  label: string
  count?: number
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className={SECTION_LABEL_CLASS}>{label}</span>
      {typeof count === "number" && (
        <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{count}</span>
      )}
    </div>
  )
}

interface SessionRowProps {
  session: Session
  parentSessions?: Session[]
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
  /** Multi-select: rows become checkboxes toggling membership in the batch.
   *  `shiftKey` (desktop) turns the click into a range select from the anchor. */
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
}

const SessionRow = React.memo(function SessionRow({
  session,
  parentSessions,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  handleStop,
  handleArchive,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: SessionRowProps) {
  const sessionIsActive = session.id === selectedId
  const isSelected = !!selectionMode && !!selectedIds?.has(session.id)
  const stallNow = useStallClock(session.status === "running")
  const sessionDot = getStatusDot(session, readSessions, false, stallNow)
  const sessionTitle = fixTitle(session.title, session.employee)
  const displayTitle = cleanPreview(sessionTitle) || sessionTitle
  const sessionTime = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isRenaming = renamingSessionId === session.id
  const RowTag = isRenaming ? "div" : "button"

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <RowTag
          draggable={!isRenaming && !selectionMode}
          data-chat-session-row={session.id}
          {...(!selectionMode && chatSessionDragProps(session.id))}
          {...(selectionMode && !isRenaming && {
            role: "checkbox",
            "aria-checked": isSelected,
            "aria-label": `Select ${displayTitle}`,
          })}
          {...(!isRenaming && { onClick: (e: React.MouseEvent) => {
            if (selectionMode) {
              onToggleSelect?.(session.id, e.shiftKey)
              return
            }
            onSelect(session.id)
            onEmployeeSessionsAvailable?.(parentSessions ?? [session])
          }})}
          className={cn(
            "group/session relative flex w-full items-center gap-2.5 border-l-2 px-4 py-2 text-left transition-colors",
            parentSessions
              ? "pl-11"
              : "pl-6",
            sessionIsActive
              ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
              : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
          )}
        >
          {selectionMode ? <SessionSelectCheckbox checked={isSelected} /> : null}
          {sessionDot ? (
            <StatusDot
              color={sessionDot.color}
              pulse={sessionDot.pulse}
              title={sessionDot.label}
              className="size-1.5"
            />
          ) : null}
          {isRenaming ? (
            <input
              autoFocus
              maxLength={200}
              defaultValue={displayTitle}
              className={cn(
                "min-w-0 flex-1 truncate border-none bg-transparent text-subheadline outline-none ring-1 ring-[var(--text-quaternary)] rounded px-0.5",
                sessionIsActive ? "font-medium text-foreground" : "text-[var(--text-secondary)]"
              )}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  renameCancelledRef.current = true
                  setRenamingSessionId(null)
                }
              }}
              onBlur={(e) => {
                if (renameCancelledRef.current) {
                  renameCancelledRef.current = false
                  return
                }
                const val = e.target.value.trim()
                if (val && val !== displayTitle) {
                  updateSessionTitle(session.id, val)
                }
                setRenamingSessionId(null)
              }}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-subheadline",
                sessionIsActive ? "font-medium text-foreground" : "text-[var(--text-secondary)]"
              )}
            >
              {cleanPreview(sessionTitle) || "Untitled"}
            </span>
          )}
          <WorkflowSessionChip session={session} />
          {isPinned ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] transition-opacity group-hover/session:lg:opacity-0 group-has-[[data-state=open]]/session:lg:opacity-0" />
          ) : null}
          <span className="shrink-0 text-caption2 tabular-nums text-[var(--text-quaternary)] transition-opacity group-hover/session:lg:opacity-0 group-has-[[data-state=open]]/session:lg:opacity-0">{sessionTime}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                aria-label="Session actions"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:absolute lg:right-2 lg:top-1/2 lg:size-7 lg:-translate-y-1/2 lg:hidden group-hover/session:lg:flex group-has-[[data-state=open]]/session:lg:flex"
              >
                <EllipsisVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
              <SessionRowMenu
                variant="dropdown"
                session={session}
                isPinned={isPinned}
                isArchived={isArchived}
                onRename={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}
                onTogglePin={() => togglePin(session.id)}
                onDuplicate={() => handleDuplicate(session.id)}
                onArchive={() => handleArchive(session)}
                onStop={() => handleStop(session.id)}
                onDelete={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </RowTag>
      </ContextMenuTrigger>
      <ContextMenuContent className={SESSION_MENU_CONTENT_CLASS}>
        <SessionRowMenu
          variant="context"
          session={session}
          isPinned={isPinned}
          isArchived={isArchived}
          onRename={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}
          onTogglePin={() => togglePin(session.id)}
          onDuplicate={() => handleDuplicate(session.id)}
          onArchive={() => handleArchive(session)}
          onStop={() => handleStop(session.id)}
          onDelete={() => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" })}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface FlatSessionRowProps {
  session: Session
  /** Avatar/identity slug — employee name, or the portal slug for direct chats. */
  avatarName: string
  /** Human label shown on line 1 (employee display name or portal name). */
  displayName: string
  /** Rows inside the Pinned section drop the per-row pin glyph — the section
   *  header already carries that signal. */
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
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string, shiftKey?: boolean) => void
}

// One CHAT per row (Pinned / Today / Yesterday / search): a single line led by
// the TITLE — the thing the operator scans to switch — with a small emoji
// avatar carrying identity ambiently. The employee's name lives in the hover
// tooltip and the thread header, not in the row. Distinct from SessionRow
// (indented, used for an expanded employee group's children).
const FlatSessionRow = React.memo(function FlatSessionRow({
  session,
  avatarName,
  displayName,
  hidePin,
  tree,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  handleStop,
  handleArchive,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
  selectionMode,
  selectedIds,
  onToggleSelect,
}: FlatSessionRowProps) {
  const isActive = session.id === selectedId
  const isSelected = !!selectionMode && !!selectedIds?.has(session.id)
  const stallNow = useStallClock(session.status === "running")
  const dot = getStatusDot(session, readSessions, false, stallNow)
  const rawTitle = fixTitle(session.title, session.employee)
  const displayTitle = cleanPreview(rawTitle) || "Untitled"
  const time = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isArchived = isArchivedSession(session)
  const isRenaming = renamingSessionId === session.id
  const isUnread =
    !readSessions.has(session.id) && session.status !== "running" && session.status !== "error"

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          title={`${displayName} · ${displayTitle}`}
          data-tree-depth={tree?.depth}
          className={cn(
            "group/flat relative flex w-full items-center gap-2.5 border-l-2 py-[7px] pl-3.5 pr-3 text-left transition-colors",
            tree && "gap-1.5",
            isActive
              ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
              : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
          )}
          style={tree ? { paddingLeft: treeRowPadding(tree.depth, "desktop") } : undefined}
        >
          {tree ? <TreeLead sessionId={session.id} title={displayTitle} meta={tree} variant="desktop" /> : null}
          <button
            draggable={!selectionMode}
            data-chat-session-row={session.id}
            {...(!selectionMode && chatSessionDragProps(session.id))}
            {...(selectionMode && {
              role: "checkbox",
              "aria-checked": isSelected,
              "aria-label": `Select ${displayTitle}`,
            })}
            onClick={(e: React.MouseEvent) => {
              if (selectionMode) {
                onToggleSelect?.(session.id, e.shiftKey)
                return
              }
              onSelect(session.id)
              onEmployeeSessionsAvailable?.([session])
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          >
            {selectionMode ? <SessionSelectCheckbox checked={isSelected} /> : null}
            <span className="relative flex size-[22px] shrink-0 items-center justify-center">
              <EmployeeAvatar name={avatarName} size={22} />
              {dot ? (
                <StatusDot
                  color={dot.color}
                  pulse={dot.pulse}
                  title={dot.label}
                  className="absolute -bottom-px -right-px size-2 border-2 border-[var(--sidebar-bg)]"
                />
              ) : null}
            </span>
            {isRenaming ? (
              <input
                autoFocus
                maxLength={200}
                defaultValue={displayTitle}
                className="min-w-0 flex-1 truncate rounded border-none bg-transparent px-0.5 text-subheadline text-[var(--text-secondary)] outline-none ring-1 ring-[var(--text-quaternary)]"
                onFocus={(e) => e.target.select()}
                onClick={(e) => { e.stopPropagation(); e.preventDefault() }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  else if (e.key === "Escape") { renameCancelledRef.current = true; setRenamingSessionId(null) }
                }}
                onBlur={(e) => {
                  if (renameCancelledRef.current) { renameCancelledRef.current = false; return }
                  const val = e.target.value.trim()
                  if (val && val !== displayTitle) updateSessionTitle(session.id, val)
                  setRenamingSessionId(null)
                }}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-subheadline",
                  isUnread || isActive
                    ? "font-medium text-foreground"
                    : "text-[var(--text-secondary)]"
                )}
              >
                {displayTitle}
              </span>
            )}
            {tree ? <TreeMarker meta={tree} variant="desktop" /> : null}
            <SessionAttentionChips session={session} />
          </button>

          {tree ? <TreeCollapsedCount meta={tree} /> : null}
          {isArchived ? (
            <span className="shrink-0 text-caption2 font-medium text-[var(--text-tertiary)]">Archived</span>
          ) : null}
          <WorkflowSessionChip session={session} />
          {isPinned && !hidePin ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] transition-opacity group-hover/flat:lg:opacity-0 group-has-[[data-state=open]]/flat:lg:opacity-0" />
          ) : null}
          <span className="shrink-0 text-caption2 tabular-nums text-[var(--text-quaternary)] transition-opacity group-hover/flat:lg:opacity-0 group-has-[[data-state=open]]/flat:lg:opacity-0">{time}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                aria-label="Chat actions"
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:absolute lg:right-2 lg:top-1/2 lg:size-7 lg:-translate-y-1/2 lg:hidden group-hover/flat:lg:flex group-has-[[data-state=open]]/flat:lg:flex"
              >
                <EllipsisVertical className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
              <SessionRowMenu
                variant="dropdown"
                session={session}
                isPinned={isPinned}
                isArchived={isArchived}
                onRename={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}
                onTogglePin={() => togglePin(session.id)}
                onDuplicate={() => handleDuplicate(session.id)}
                onArchive={() => handleArchive(session)}
                onStop={() => handleStop(session.id)}
                onDelete={() => setDeleteTarget({ type: "session", id: session.id, label: displayTitle })}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={SESSION_MENU_CONTENT_CLASS}>
        <SessionRowMenu
          variant="context"
          session={session}
          isPinned={isPinned}
          isArchived={isArchived}
          onRename={() => { renameCancelledRef.current = false; setRenamingSessionId(session.id) }}
          onTogglePin={() => togglePin(session.id)}
          onDuplicate={() => handleDuplicate(session.id)}
          onArchive={() => handleArchive(session)}
          onStop={() => handleStop(session.id)}
          onDelete={() => setDeleteTarget({ type: "session", id: session.id, label: displayTitle })}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
})

interface EmployeeRowProps {
  item: FlatItem
  selectedId: string | null
  readSessions: Set<string>
  pinnedSessions: Set<string>
  expanded: Record<string, boolean>
  renamingSessionId: string | null
  renameCancelledRef: React.MutableRefObject<boolean>
  fixTitle: (title: string | undefined, employee: string | undefined) => string
  onSelect: (id: string) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  togglePin: (pinKey: string) => void
  handleMarkAllRead: (sessions: Session[]) => void
  handleEmployeeClick: (item: FlatItem) => void
  setDeleteTarget: (target: { type: "session" | "employee" | "bulk"; id: string; label: string; sessions?: Session[] } | null) => void
  onLoadMore: (groupKey: string, offset: number) => void
  loadingMore: Set<string>
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
  handleDuplicate: (sessionId: string) => void
  handleStop: (sessionId: string) => void
  handleArchive: (session: Session) => void
  variant: "desktop" | "mobile"
}

const EmployeeRow = React.memo(function EmployeeRow({
  item,
  variant,
  selectedId,
  readSessions,
  pinnedSessions,
  expanded,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleMarkAllRead,
  handleEmployeeClick,
  setDeleteTarget,
  onLoadMore,
  loadingMore,
  setRenamingSessionId,
  updateSessionTitle,
  handleDuplicate,
  handleStop,
  handleArchive,
}: EmployeeRowProps) {
  const empName = item.employeeName!
  const empSessions = item.sessions!
  const latestSession = empSessions[0]
  const empInfo = item.employeeData
  const displayName = empInfo?.displayName || titleCase(empName)
  const timeLabel = formatTime(getSessionActivity(latestSession))
  const isActive = empSessions.some((s) => s.id === selectedId)
  const isPinned = pinnedSessions.has(item.pinKey)
  const loadedCount = empSessions.length
  // True total from the server; may exceed what's loaded so far.
  const sessionCount = item.total ?? loadedCount
  const groupKey = item.groupKey ?? empName
  const isLoadingMore = loadingMore.has(groupKey)
  const isExpanded = expanded[empName] || false
  const hasUnread = empSessions.some(
    (s) => !readSessions.has(s.id) && s.status !== "running" && s.status !== "error"
  )
  // The group dot reflects the latest session's live state, but escalates to an
  // "unread" accent dot when any chat in the group is unread.
  const stallNow = useStallClock(latestSession?.status === "running")
  const empDot = getStatusDot(latestSession, readSessions, hasUnread, stallNow)

  const sessionRowProps = {
    selectedId,
    readSessions,
    pinnedSessions,
    renamingSessionId,
    renameCancelledRef,
    fixTitle,
    onSelect,
    onEmployeeSessionsAvailable,
    togglePin,
    handleDuplicate,
    handleStop,
    handleArchive,
    setDeleteTarget,
    setRenamingSessionId,
    updateSessionTitle,
    selectionMode: false,
    selectedIds: undefined,
    onToggleSelect: undefined,
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={() => handleEmployeeClick(item)}
            className={cn(
              "group/emp relative flex w-full items-center gap-2.5 border-l-2 py-2 pl-3.5 pr-3 text-left transition-colors",
              isActive
                ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-[var(--fill-tertiary)]"
            )}
          >
            <div className="relative flex size-7 shrink-0 items-center justify-center">
              <EmployeeAvatar name={empName} size={28} />
              {empDot ? (
                <StatusDot
                  color={empDot.color}
                  pulse={empDot.pulse}
                  title={empDot.label}
                  className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
                />
              ) : null}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 pr-9 lg:pr-0">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-subheadline text-foreground",
                    "font-medium"
                  )}
                >
                  {displayName}
                </span>
                <span className="shrink-0 text-caption2 tabular-nums text-[var(--text-quaternary)] transition-opacity group-hover/emp:lg:opacity-0 group-has-[[data-state=open]]/emp:lg:opacity-0">{timeLabel}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      aria-label="Employee chat actions"
                      className="absolute right-1 top-1/2 flex size-9 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:right-2 lg:size-7 lg:hidden group-hover/emp:lg:flex group-has-[[data-state=open]]/emp:lg:flex"
                    >
                      <EllipsisVertical className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
                    <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => togglePin(item.pinKey)}>
                      <Pin aria-hidden />
                      {isPinned ? "Unpin" : "Pin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => handleMarkAllRead(empSessions)}>
                      <Focus aria-hidden />
                      Mark all as read
                    </DropdownMenuItem>
                    <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
                    <DropdownMenuItem className={`${SESSION_MENU_ITEM_CLASS} text-[var(--system-red)] focus:text-[var(--system-red)] [&_svg]:text-[var(--system-red)]`} variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
                      <Trash2 aria-hidden />
                      Delete all chats
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex items-center gap-1.5 overflow-hidden text-caption2 text-[var(--text-quaternary)]">
                <span className="shrink-0 tabular-nums">
                  {sessionCount === 1 ? "1 chat" : `${sessionCount} chats`}
                </span>
                <WorkflowSessionChip session={latestSession} />
                {isPinned ? (
                  <Pin className="size-3 shrink-0 text-[var(--text-tertiary)]" />
                ) : null}
              </div>
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className={SESSION_MENU_CONTENT_CLASS}>
          <ContextMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => togglePin(item.pinKey)}>
            <Pin aria-hidden />
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem className={SESSION_MENU_ITEM_CLASS} onClick={() => handleMarkAllRead(empSessions)}>
            <Focus aria-hidden />
            Mark all as read
          </ContextMenuItem>
          <ContextMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
          <ContextMenuItem className={`${SESSION_MENU_ITEM_CLASS} text-[var(--system-red)] focus:text-[var(--system-red)] [&_svg]:text-[var(--system-red)]`} variant="destructive" onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}>
            <Trash2 aria-hidden />
            Delete all chats
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && loadedCount > 1 ? (
        empSessions.map((session) => (
          variant === "mobile" ? (
            <MobileSessionRow key={session.id} session={session} avatarName={empName} displayName={displayName} {...sessionRowProps} />
          ) : (
            <SessionRow key={session.id} session={session} parentSessions={empSessions} {...sessionRowProps} />
          )
        ))
      ) : null}
      {isExpanded && loadedCount < sessionCount ? (
        <button
          onClick={() => onLoadMore(groupKey, loadedCount)}
          disabled={isLoadingMore}
          className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-caption2 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
        >
          {isLoadingMore ? "Loading…" : `+${sessionCount - loadedCount} more`}
        </button>
      ) : null}
    </div>
  )
})

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  onArchive,
  onUnarchive,
  onDuplicate,
  onSessionsLoaded,
  onEmployeeSessionsAvailable,
  onOrderComputed,
  onContactEmployee,
  onSessionsRemoved,
  onOpenBeside,
  variant = "desktop",
}: ChatSidebarProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? PRODUCT_NAME
  // The slug matches session.employee, so it keeps the internal codename.
  const portalSlug = (settings.portalName ?? "Jinn").toLowerCase()

  const qc = useQueryClient()
  const { data: rawSessions, isLoading: loading } = useSessions()
  const { data: pinnedSessionRows = [] } = usePinnedSessions()
  const { data: meta } = useSessionCounts()
  const counts = meta?.counts ?? {}
  const updateSessionMutation = useUpdateSession()
  const deleteSessionMutation = useDeleteSession()
  const archiveSessionMutation = useArchiveSession()
  const unarchiveSessionMutation = useUnarchiveSession()
  const stopSessionMutation = useStopSession()
  const bulkDeleteMutation = useBulkDeleteSessions()
  const duplicateSessionMutation = useDuplicateSession()
  const { data: pinnedSessions = EMPTY_PINNED_SESSIONS } = usePins()
  const { data: terminalHosts } = useTerminalHosts()
  const { mutate: mutatePin } = useTogglePin()

  const sessions = useMemo(() => {
    if (!rawSessions) return []
    const filtered = (rawSessions as Session[]).filter(isVisibleSource)
    const loadedIds = new Set(filtered.map((session) => session.id))
    for (const session of pinnedSessionRows as Session[]) {
      if (isVisibleSource(session) && !loadedIds.has(session.id)) {
        filtered.push(session)
        loadedIds.add(session.id)
      }
    }
    filtered.sort((a, b) => {
      const ta = a.lastActivity || a.createdAt || ""
      const tb = b.lastActivity || b.createdAt || ""
      return tb.localeCompare(ta)
    })
    return filtered
  }, [rawSessions, pinnedSessionRows])

  const [search, setSearch] = useState("")
  // Search spans ALL sessions server-side (the loaded page is only a subset).
  const { data: searchResults } = useSessionSearch(search)
  // The slim control row morphs between the Focused/All segmented control and an
  // inline search field; `searchOpen` drives that reveal. Collapsing always
  // clears the query so a hidden field can never leave the list silently filtered.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearch("")
  }, [])
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const renameCancelledRef = useRef(false)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [olderExpanded, setOlderExpanded] = useState(false)
  const [pinnedExpanded, setPinnedExpanded] = useState(false)
  const [focusMode, setFocusMode] = useState<FocusMode>("all")
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(new Set())
  const [loadingMore, setLoadingMore] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "session" | "employee" | "bulk"
    id: string
    label: string
    sessions?: Session[]
  } | null>(null)
  // Multi-select: entering selection mode turns every session row into a
  // checkbox toggling membership here, so Archive/Delete act on the batch.
  // Leaving the mode always clears the batch — a stale id surviving into the
  // next session would let a bulk action touch a row the operator never saw.
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Shift-click selects a run between two rows, so it needs a fixed origin: the
  // last row clicked WITHOUT shift. It stays put while a later shift-click
  // recomputes the run from it, rather than growing the old one (Finder/Gmail).
  // Held as a row key (see rowKey below), not a bare id: in Tree view a pinned
  // parent renders twice, and a range must start at the copy that was clicked.
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const { data: orgData } = useOrg()
  const employeeData = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const emp of orgData?.employees ?? []) {
      map.set(emp.name, emp)
    }
    return map
  }, [orgData])
  const onSessionsLoadedRef = useRef(onSessionsLoaded)

  useEffect(() => {
    onSessionsLoadedRef.current = onSessionsLoaded
  }, [onSessionsLoaded])

  useEffect(() => {
    if (sessions.length > 0) {
      startTransition(() => {
        onSessionsLoadedRef.current?.(sessions)
      })
    }
  }, [sessions])

  useEffect(() => {
    setReadSessions(getReadSessions())
    setExpanded(loadExpandedState())
    try {
      setOlderExpanded(localStorage.getItem(OLDER_EXPANDED_STORAGE_KEY) === "true")
      setPinnedExpanded(localStorage.getItem(PINNED_EXPANDED_STORAGE_KEY) === "true")
      const stored = localStorage.getItem(FOCUS_MODE_STORAGE_KEY)
      if (stored === "focused" || stored === "all" || stored === "tree") setFocusMode(stored)
    } catch {}
    setTreeCollapsed(loadTreeCollapsed())
  }, [])

  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions((prev) => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])


  // Focus the inline search field once it has morphed open.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const selectFocusMode = useCallback((mode: FocusMode) => {
    setFocusMode(mode)
    try { localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode) } catch {}
  }, [])

  const toggleTreeCollapsed = useCallback((sessionId: string) => {
    setTreeCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      saveTreeCollapsed(next)
      return next
    })
  }, [])

  const toggleOlderExpanded = useCallback(() => {
    setOlderExpanded((prev) => {
      const next = !prev
      try { localStorage.setItem(OLDER_EXPANDED_STORAGE_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  const togglePinnedExpanded = useCallback(() => {
    setPinnedExpanded((prev) => {
      const next = !prev
      try { localStorage.setItem(PINNED_EXPANDED_STORAGE_KEY, String(next)) } catch {}
      return next
    })
  }, [])

  // Fetch the next page for one group and merge it into the cached session list.
  const handleLoadMore = useCallback(async (groupKey: string, offset: number) => {
    if (loadingMore.has(groupKey)) return
    setLoadingMore((prev) => new Set(prev).add(groupKey))
    try {
      const more = await api.getSessionsForGroup(groupKey, offset, 50)
      qc.setQueryData<SessionsResponse>(queryKeys.sessions.all, (old) => {
        if (!old) return old
        const seen = new Set(old.sessions.map((s) => s.id as string))
        const merged = [...old.sessions, ...more.filter((s) => !seen.has(s.id as string))]
        return { ...old, sessions: merged }
      })
    } catch {
      /* surfaced by the disabled state resetting; non-fatal */
    } finally {
      setLoadingMore((prev) => {
        const next = new Set(prev)
        next.delete(groupKey)
        return next
      })
    }
  }, [qc, loadingMore])

  const toggleEmployeeExpanded = useCallback((empName: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [empName]: !prev[empName] }
      saveExpandedState(next)
      return next
    })
  }, [])

  const togglePin = useCallback((pinKey: string) => {
    mutatePin({ key: pinKey, pinned: !pinnedSessions.has(pinKey) })
  }, [pinnedSessions, mutatePin])

  const handleMarkAllRead = useCallback((empSessions: Session[]) => {
    markAllReadForEmployee(empSessions)
    setReadSessions((prev) => {
      const next = new Set(prev)
      for (const s of empSessions) next.add(s.id)
      return next
    })
  }, [])

  async function handleDeleteEmployee(empName: string, empSessions: Session[]) {
    const ids = empSessions.map((s) => s.id)
    try {
      await bulkDeleteMutation.mutateAsync(ids)
      const employeePin = `emp:${empName}`
      if (pinnedSessions.has(employeePin)) {
        mutatePin({ key: employeePin, pinned: false })
      }
      startTransition(() => {
        if (selectedId && ids.includes(selectedId)) onNewChat()
      })
    } catch {}
  }

  async function handleDelete(sessionId: string) {
    // The page-level routine owns delete resolution end-to-end (mutation,
    // tab close, ONE atomic history REPLACE to the fallback session) so all
    // entry points — this row menu, the page ⋯ menu, Backspace — navigate
    // identically. No selection writes from here.
    if (onDelete) {
      onDelete(sessionId)
      return
    }
    // Embedders without onDelete: previous minimal behavior.
    try {
      await deleteSessionMutation.mutateAsync(sessionId)
      startTransition(() => {
        if (selectedId === sessionId) onNewChat()
      })
    } catch {}
  }

  async function handleArchive(session: Session) {
    try {
      if (isArchivedSession(session)) {
        if (onUnarchive) {
          onUnarchive(session.id)
          return
        }
        await unarchiveSessionMutation.mutateAsync(session.id)
        return
      }
      if (onArchive) {
        onArchive(session.id)
        return
      }
      await archiveSessionMutation.mutateAsync(session.id)
      if (selectedId === session.id) onNewChat()
    } catch {}
  }

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setSelectionAnchorKey(null)
  }, [])

  async function handleBulkArchive() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    // Sequential, and each id handled on its own: the archive route is
    // per-session and answers 409 for a running/waiting chat, so a single
    // refusal must not abort the rest of the batch (the loop body is the whole
    // point of not using one bulk endpoint here).
    const archived: string[] = []
    const failed: string[] = []
    for (const id of ids) {
      try {
        await archiveSessionMutation.mutateAsync(id)
        archived.push(id)
        if (selectedId === id) onNewChat()
      } catch {
        failed.push(id)
      }
    }
    if (archived.length > 0) onSessionsRemoved?.(archived)
    exitSelection()
    // A partial batch must not look like a full one: the selection clearing is
    // otherwise indistinguishable from "everything archived".
    if (failed.length > 0) {
      window.alert(`${failed.length} of ${ids.length} chats could not be archived. Stop a running or waiting chat first, then try again.`)
    }
  }

  async function handleBulkDelete(targets: Session[]) {
    const ids = targets.map((s) => s.id)
    if (ids.length === 0) return
    try {
      await bulkDeleteMutation.mutateAsync(ids)
      onSessionsRemoved?.(ids)
      if (selectedId && ids.includes(selectedId)) onNewChat()
    } catch {
      window.alert("Bulk delete failed. Nothing was deleted.")
    }
    exitSelection()
  }

  const {
    searching,
    searchRows,
    pinnedRows,
    todayRows,
    yesterdayRows,
    olderRows,
    hiddenAutomated,
    pinnedFlat,
    unpinnedFlat,
    cronTotal,
    terminalRows,
    treeToday,
    treeYesterday,
    treeOlder,
  } = useMemo(() => {
    // When searching, use server results (spans all sessions); "load more" is
    // disabled in this mode since totals reflect the search, not each group.
    const searching = search.trim().length > 0
    const displayed = searching
      ? ((searchResults as Session[] | undefined) ?? []).filter(isVisibleSource)
      : sessions

    // Resolve the avatar slug + human label for a flat row (see resolveRowIdentity).
    const toRow = (s: Session): FlatRow => ({
      session: s,
      ...resolveRowIdentity(s, { portalSlug, portalName, employeeData }),
    })

    // ---- Search mode: one flat list spanning everything matched. ----
    if (searching) {
      const searchRows = sortSessionsByActivity(displayed).map(toRow)
      return {
        searching,
        searchRows,
        pinnedRows: [] as FlatRow[],
        todayRows: [] as FlatRow[],
        yesterdayRows: [] as FlatRow[],
        olderRows: [] as FlatRow[],
        hiddenAutomated: 0,
        pinnedFlat: [] as FlatItem[],
        unpinnedFlat: [] as FlatItem[],
        cronTotal: 0,
        terminalRows: [] as FlatRow[],
        treeToday: [] as SessionTreeNode[],
        treeYesterday: [] as SessionTreeNode[],
        treeOlder: [] as SessionTreeNode[],
      }
    }

    // ---- Default mode. In Focused, the recency buckets (Today / Yesterday /
    // Older) hold only the operator's own top-level chats (isFocusedSession) —
    // delegated and automated sessions never flood the switcher. "All" shows
    // every visible session as flat rows (children, workflow runs, the lot)
    // and reveals the per-employee Team directory (every employee's full
    // session history, grouped, with true counts).
    // Cron sessions are excluded entirely: Scheduled lives on the Cron page,
    // reachable through the quiet link-row at the end of the list.
    const now = new Date()
    let cronLoaded = 0
    const directSessions: Session[] = []
    const employeeSessionMap = new Map<string, Session[]>()
    const pinnedRows: FlatRow[] = []
    const todayRows: FlatRow[] = []
    const yesterdayRows: FlatRow[] = []
    // Older = older user-initiated chats, as flat rows (computed from loaded
    // sessions; the deep tail beyond the per-group window is reachable via
    // search, and per-employee history via the Team directory).
    const olderRows: FlatRow[] = []
    // Terminals get their own section and never count as chats.
    const terminalRows: FlatRow[] = []
    let hiddenAutomated = 0
    // Tree: every session All would show as a flat row, pinned ones included —
    // a pinned parent must not strand its children as orphans.
    const treeSessions: Session[] = []

    for (const s of displayed) {
      if (isCronSession(s)) {
        cronLoaded += 1
        // A pinned cron session still floats — pins are explicit intent.
        if (shouldFloatPinned(s, pinnedSessions)) pinnedRows.push(toRow(s))
        continue
      }
      if (isTerminalSession(s)) {
        if (shouldFloatPinned(s, pinnedSessions)) pinnedRows.push(toRow(s))
        else terminalRows.push(toRow(s))
        continue
      }
      const isDirect = isDirectSession(s, portalSlug)
      const groupKey = isDirect ? DIRECT_GROUP : s.employee!
      if (isDirect) directSessions.push(s)
      else {
        if (!employeeSessionMap.has(groupKey)) employeeSessionMap.set(groupKey, [])
        employeeSessionMap.get(groupKey)!.push(s)
      }
      if (focusMode === "tree") treeSessions.push(s)
      // Pinned chats float to the Pinned section at the top, regardless of
      // bucket or focus mode. They still feed the employee groups above (the
      // Team directory keeps full history; overlap is de-duped in allFlatIds).
      if (shouldFloatPinned(s, pinnedSessions)) {
        pinnedRows.push(toRow(s))
        continue
      }
      if (focusMode === "tree") continue
      // All means all: every visible non-cron session is a flat recency row —
      // delegated children, workflow runs (badged by the indigo
      // WorkflowSessionChip), the lot. Focused stays strictly the operator's
      // own chats; the Team directory keeps the grouped per-employee view.
      if (focusMode !== "all" && !isFocusedSession(s)) {
        hiddenAutomated += 1
        continue
      }
      const bucket = bucketByDay(getSessionActivity(s), now)
      if (bucket === "today") todayRows.push(toRow(s))
      else if (bucket === "yesterday") yesterdayRows.push(toRow(s))
      else olderRows.push(toRow(s))
    }

    pinnedRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    todayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    yesterdayRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))
    olderRows.sort((a, b) => getSessionActivity(b.session).localeCompare(getSessionActivity(a.session)))

    // Per-employee groups (full history) — the All-mode Team directory + E-shortcut.
    const flatItems: FlatItem[] = []
    for (const [empName, empSessions] of employeeSessionMap) {
      const sorted = sortSessionsByActivity(empSessions)
      flatItems.push({
        type: "employee",
        employeeName: empName,
        employeeData: employeeData.get(empName),
        sessions: sorted,
        sortKey: getSessionActivity(sorted[0]),
        pinKey: `emp:${empName}`,
        groupKey: empName,
        total: counts[empName] ?? sorted.length,
      })
    }
    if (directSessions.length > 0) {
      const sorted = sortSessionsByActivity(directSessions)
      flatItems.push({
        type: "employee",
        employeeName: portalSlug,
        employeeData: {
          name: portalSlug,
          displayName: portalName,
          emoji: "\u{1F4AC}",
          department: "direct",
          role: "",
          rank: "manager",
          engine: "",
          model: "",
          persona: "",
        } as Employee,
        sessions: sorted,
        sortKey: getSessionActivity(sorted[0]),
        pinKey: `emp:${portalSlug}`,
        groupKey: DIRECT_GROUP,
        total: counts[DIRECT_GROUP] ?? sorted.length,
      })
    }

    const pinnedFlat = flatItems
      .filter((item) => pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    const unpinnedFlat = flatItems
      .filter((item) => !pinnedSessions.has(item.pinKey))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey))

    const cronTotal = counts[CRON_GROUP] ?? cronLoaded

    // Tree roots go into the recency buckets by the newest activity anywhere
    // below them, so a busy child keeps its root in Today. A pinned session
    // with no family already sits in Pinned and is left out; one with
    // children keeps its place so the children stay nested.
    const treeToday: SessionTreeNode[] = []
    const treeYesterday: SessionTreeNode[] = []
    const treeOlder: SessionTreeNode[] = []
    if (focusMode === "tree") {
      for (const root of buildSessionForest(treeSessions)) {
        if (root.children.length === 0 && pinnedSessions.has(root.session.id)) continue
        const bucket = bucketByDay(root.activity, now)
        if (bucket === "today") treeToday.push(root)
        else if (bucket === "yesterday") treeYesterday.push(root)
        else treeOlder.push(root)
      }
    }

    return {
      searching,
      searchRows: [] as FlatRow[],
      pinnedRows,
      todayRows,
      yesterdayRows,
      olderRows,
      hiddenAutomated,
      pinnedFlat,
      unpinnedFlat,
      cronTotal,
      terminalRows,
      treeToday,
      treeYesterday,
      treeOlder,
    }
  }, [sessions, search, searchResults, employeeData, portalSlug, portalName, pinnedSessions, counts, focusMode])

  // The Tree view's visible rows per bucket, honouring folded parents. Split
  // from the memo above so folding a parent does not rebuild the forest.
  const treeRows = useMemo(() => {
    // Sessions the tree leaves out on purpose (Scheduled runs, terminals) are
    // still loaded; a child of one is started automatically, not orphaned.
    const loadedElsewhere = new Set<string>()
    for (const s of sessions) if (isCronSession(s) || isTerminalSession(s)) loadedElsewhere.add(s.id)
    const rowsFor = (roots: SessionTreeNode[]): TreeVisibleRow[] =>
      flattenSessionForest(roots, treeCollapsed).map((tree) => {
        const hiddenSignal = tree.collapsed ? hiddenTreeSignal(subtreeSessions(tree.node).slice(1), readSessions) : null
        if (tree.node.rootKind === "orphan" && loadedElsewhere.has(String(tree.node.session.parentSessionId).trim())) {
          tree = { ...tree, node: { ...tree.node, rootKind: "root" } }
        }
        return {
          row: { session: tree.node.session, ...resolveRowIdentity(tree.node.session, { portalSlug, portalName, employeeData }) },
          tree,
          hiddenSignal,
        }
      })
    const total = (roots: SessionTreeNode[]) => roots.reduce((n, root) => n + 1 + root.descendantCount, 0)
    return {
      today: rowsFor(treeToday),
      yesterday: rowsFor(treeYesterday),
      older: rowsFor(treeOlder),
      todayCount: total(treeToday),
      yesterdayCount: total(treeYesterday),
      olderCount: total(treeOlder),
    }
  }, [sessions, treeToday, treeYesterday, treeOlder, treeCollapsed, readSessions, portalSlug, portalName, employeeData])

  // Contactable employees: the full org roster MERGED with the employees that
  // already have sessions, then sliced down to the roster-only tail (employees
  // with ZERO sessions). These are listed so they can be contacted directly.
  // Hidden while searching (search spans real sessions, not the roster) and the
  // COO/portal row is excluded (reachable via "New chat").
  const contactableEmployees = useMemo(() => {
    if (search.trim()) return []
    const sessionful = [...pinnedFlat, ...unpinnedFlat]
      .map((item) => item.employeeName)
      .filter((n): n is string => !!n)
    const sessionfulSet = new Set(sessionful)
    const rosterNames = (orgData?.employees ?? []).map((e) => e.name)
    const merged = mergeSidebarEmployees(sessionful, rosterNames)
    return merged
      .filter((name) => !sessionfulSet.has(name) && name !== portalSlug)
      .map((name) => employeeData.get(name))
      .filter((e): e is Employee => !!e)
  }, [search, pinnedFlat, unpinnedFlat, orgData, employeeData, portalSlug])

  // Emit flat session order for keyboard navigation (J/K/E shortcuts).
  // Visual order: Pinned (visible slice) → Today → Yesterday → (Older, if open)
  // → (Team directory groups, All mode). De-duped — an employee group's
  // sessions can overlap the Pinned/Today/Yesterday rows.
  const orderRef = useRef<string>('')
  const allFlatIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    const push = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id) } }

    if (searching) {
      for (const r of searchRows) push(r.session.id)
      return { sessionIds: ids, employeeNames: [] as string[], employeeSessionMap: {} as Record<string, string[]> }
    }

    const visiblePinned = pinnedExpanded ? pinnedRows : pinnedRows.slice(0, PINNED_VISIBLE)
    for (const r of visiblePinned) push(r.session.id)
    for (const r of todayRows) push(r.session.id)
    for (const r of yesterdayRows) push(r.session.id)
    if (olderExpanded) {
      for (const r of olderRows) push(r.session.id)
    }
    for (const r of treeRows.today) push(r.row.session.id)
    for (const r of treeRows.yesterday) push(r.row.session.id)
    if (olderExpanded) {
      for (const r of treeRows.older) push(r.row.session.id)
    }
    for (const r of terminalRows) push(r.session.id)
    if (focusMode !== "focused") {
      for (const item of [...pinnedFlat, ...unpinnedFlat]) {
        const sessionIds = item.sessions!.map((s) => s.id)
        // Collapsed employee row reaches only its latest session; expanded reaches all.
        if (expanded[item.employeeName!]) sessionIds.forEach(push)
        else if (sessionIds.length) push(sessionIds[0])
      }
    }

    // E-shortcut cycles every employee with sessions, regardless of mode.
    const empNames: string[] = []
    const empMap: Record<string, string[]> = {}
    for (const item of [...pinnedFlat, ...unpinnedFlat]) {
      const name = item.employeeName!
      empNames.push(name)
      empMap[name] = item.sessions!.map((s) => s.id)
    }
    return { sessionIds: ids, employeeNames: empNames, employeeSessionMap: empMap }
  }, [searching, searchRows, pinnedRows, pinnedExpanded, todayRows, yesterdayRows, olderExpanded, focusMode, olderRows, treeRows, terminalRows, expanded, pinnedFlat, unpinnedFlat])

  useEffect(() => {
    const key = allFlatIds.sessionIds.join(',')
    if (key !== orderRef.current) {
      orderRef.current = key
      onOrderComputed?.(allFlatIds)
    }
  }, [allFlatIds, onOrderComputed])

  const handleEmployeeClick = useCallback((item: FlatItem) => {
    const empName = item.employeeName!
    const empSessions = item.sessions!
    if (empSessions.length > 1) {
      // Toggle expand/collapse — selecting latest session when expanding
      const wasExpanded = expanded[empName] || false
      toggleEmployeeExpanded(empName)
      if (!wasExpanded) {
        onSelect(empSessions[0].id)
        onEmployeeSessionsAvailable?.(empSessions)
      }
    } else {
      onSelect(empSessions[0].id)
      onEmployeeSessionsAvailable?.(empSessions)
    }
  }, [expanded, toggleEmployeeExpanded, onSelect, onEmployeeSessionsAvailable])

  const fixTitleCb = useCallback((title: string | undefined, employee: string | undefined) => {
    if (!title) return employee || portalName
    if (portalName !== "Jinn" && title.startsWith("Jinn - ")) {
      return portalName + title.slice(4)
    }
    return title
  }, [portalName])

  const updateSessionTitle = useCallback((id: string, title: string) => {
    updateSessionMutation.mutate({ id, data: { title } })
  }, [updateSessionMutation])

  const handleDuplicateCb = useCallback(async (sessionId: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(sessionId) as { id?: string }
      if (result?.id) {
        onDuplicate?.(result.id)
        onSelect(result.id)
        setRenamingSessionId(result.id)
        renameCancelledRef.current = false
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || "Unknown error"}`)
    }
  }, [duplicateSessionMutation, onDuplicate, onSelect])

  const handleStopCb = useCallback((sessionId: string) => {
    stopSessionMutation.mutate(sessionId)
  }, [stopSessionMutation])

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Apple nav-bar pattern: the control band carries NO line at rest, and a
  // single --separator hairline appears under it only once rows scroll beneath.
  const [listScrolled, setListScrolled] = useState(false)
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const next = e.currentTarget.scrollTop > 2
    setListScrolled((prev) => (prev === next ? prev : next))
  }, [])

  // Build one flat list for the (optional) virtualizer: section labels, flat
  // session rows (Pinned/Today/Yesterday/search), the collapsible Older
  // summary, the All-mode Team directory groups, and the Scheduled link-row.
  type VirtualItem =
    | { kind: "section"; id: string; label: string; count?: number }
    | { kind: "flat"; row: FlatRow; hidePin?: boolean }
    | { kind: "tree"; visible: TreeVisibleRow }
    | { kind: "pinned-more" }
    | { kind: "older-line" }
    | { kind: "older-header" }
    | { kind: "employee"; item: FlatItem }
    | { kind: "cron-link" }
    | { kind: "terminals" }

  const virtualItems = useMemo<VirtualItem[]>(() => {
    const list: VirtualItem[] = []
    if (searching) {
      for (const row of searchRows) list.push({ kind: "flat", row })
      return list
    }
    if (pinnedRows.length > 0) {
      // The section header carries the "pinned" signal, so rows inside it
      // drop their per-row pin glyph (hidePin) — one signal, not two. Beyond
      // PINNED_VISIBLE the section folds behind "N more pinned" so a long pin
      // list can't push Today off the first screen.
      list.push({ kind: "section", id: "pinned", label: "Pinned", count: pinnedRows.length })
      const visible = pinnedExpanded ? pinnedRows : pinnedRows.slice(0, PINNED_VISIBLE)
      for (const row of visible) list.push({ kind: "flat", row, hidePin: true })
      if (pinnedRows.length > PINNED_VISIBLE) list.push({ kind: "pinned-more" })
    }
    if (todayRows.length > 0) {
      list.push({ kind: "section", id: "today", label: "Today", count: todayRows.length })
      for (const row of todayRows) list.push({ kind: "flat", row })
    }
    if (yesterdayRows.length > 0) {
      list.push({ kind: "section", id: "yesterday", label: "Yesterday", count: yesterdayRows.length })
      for (const row of yesterdayRows) list.push({ kind: "flat", row })
    }
    if (olderRows.length > 0) {
      if (!olderExpanded) {
        list.push({ kind: "older-line" })
      } else {
        list.push({ kind: "older-header" })
        for (const row of olderRows) list.push({ kind: "flat", row })
      }
    }
    // Tree view fills the same buckets with nested rows; the counts are every
    // session in the bucket, folded or not.
    if (treeRows.today.length > 0) {
      list.push({ kind: "section", id: "today", label: "Today", count: treeRows.todayCount })
      for (const visible of treeRows.today) list.push({ kind: "tree", visible })
    }
    if (treeRows.yesterday.length > 0) {
      list.push({ kind: "section", id: "yesterday", label: "Yesterday", count: treeRows.yesterdayCount })
      for (const visible of treeRows.yesterday) list.push({ kind: "tree", visible })
    }
    if (treeRows.older.length > 0) {
      if (!olderExpanded) {
        list.push({ kind: "older-line" })
      } else {
        list.push({ kind: "older-header" })
        for (const visible of treeRows.older) list.push({ kind: "tree", visible })
      }
    }
    // Terminals sit just above the Team directory: the header's host menu opens
    // one, and the rows below it are the terminal sessions.
    const hosts = terminalHosts?.enabled ? terminalHosts.hosts : []
    if (hosts.length > 0 || terminalRows.length > 0) {
      list.push({ kind: "terminals" })
      for (const row of terminalRows) list.push({ kind: "flat", row })
    }
    // All and Tree: the Team directory — every employee with sessions as an
    // expandable group (full history, authoritative counts, load-more; a page
    // loaded here re-nests into the tree above). The contactable roster tail
    // continues this section below the virtual list.
    if (focusMode !== "focused") {
      const groups = [...pinnedFlat, ...unpinnedFlat]
      if (groups.length > 0) {
        list.push({
          kind: "section",
          id: "team",
          label: "Team",
          count: groups.length + (onContactEmployee ? contactableEmployees.length : 0),
        })
        for (const item of groups) list.push({ kind: "employee", item })
      }
    }
    if (cronTotal > 0) list.push({ kind: "cron-link" })
    return list
  }, [searching, searchRows, pinnedRows, pinnedExpanded, todayRows, yesterdayRows, olderRows, olderExpanded, treeRows, focusMode, pinnedFlat, unpinnedFlat, contactableEmployees.length, onContactEmployee, cronTotal, terminalHosts, terminalRows])

  // The selectable sessions in the order they are rendered — the only ordering
  // a shift-range can trust. Only `flat` rows are selectable in selection mode:
  // an employee group header is not a checkbox and EmployeeRow renders its child
  // rows with selectionMode false, so a range is computed over the flat rows
  // alone, skipping section labels, dividers, the "show more" rows and the cron
  // link. Tree rows are selectable too. Flat rows are disjoint (a pinned chat
  // never also lands in Today), but a pinned Tree parent shows in Pinned AND in
  // the tree, so the order is of rows, keyed by kind and id: each copy is its
  // own position, and a range maps back to the ids between two of them.
  const selectableRowOrder = useMemo(() => {
    const keys: string[] = []
    for (const vi of virtualItems) {
      if (vi.kind === "flat") keys.push(rowKey("flat", vi.row.session.id))
      else if (vi.kind === "tree") keys.push(rowKey("tree", vi.visible.row.session.id))
    }
    return keys
  }, [virtualItems])

  const toggleSelect = useCallback((sessionId: string, shiftKey = false, kind: SelectableRowKind = "flat") => {
    const clicked = rowKey(kind, sessionId)
    if (shiftKey) {
      setSelectedIds((prev) => {
        const from = selectionAnchorKey ? selectableRowOrder.indexOf(selectionAnchorKey) : -1
        const to = selectableRowOrder.indexOf(clicked)
        // No anchor, or a row no longer in the rendered order: there is no run
        // to compute, so fall back to toggling the one row.
        if (from === -1 || to === -1) {
          const next = new Set(prev)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        }
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        return new Set(selectableRowOrder.slice(lo, hi + 1).map(rowKeyId))
      })
      return
    }
    setSelectionAnchorKey(clicked)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [selectionAnchorKey, selectableRowOrder])
  const toggleSelectTreeRow = useCallback(
    (sessionId: string, shiftKey?: boolean) => toggleSelect(sessionId, shiftKey, "tree"),
    [toggleSelect],
  )

  // Shared props passed to all SessionRow and EmployeeRow instances
  const sharedRowProps = useMemo(() => ({
    selectedId,
    readSessions,
    pinnedSessions,
    renamingSessionId,
    renameCancelledRef,
    fixTitle: fixTitleCb,
    onSelect,
    onEmployeeSessionsAvailable,
    togglePin,
    handleDuplicate: handleDuplicateCb,
    handleStop: handleStopCb,
    handleArchive,
    setDeleteTarget,
    setRenamingSessionId,
    updateSessionTitle,
    selectionMode,
    selectedIds,
    onToggleSelect: toggleSelect,
  }), [selectedId, readSessions, pinnedSessions, renamingSessionId, fixTitleCb, onSelect, onEmployeeSessionsAvailable, togglePin, handleDuplicateCb, handleStopCb, updateSessionTitle, selectionMode, selectedIds, toggleSelect])

  const VIRTUALIZE_THRESHOLD = 50
  const shouldVirtualize = virtualItems.length >= VIRTUALIZE_THRESHOLD

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualItems.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!shouldVirtualize) return 52
      const vi = virtualItems[index]
      switch (vi.kind) {
        case "section": return 32
        case "terminals": return 36
        case "older-header": return 36
        case "older-line": return 40
        case "pinned-more": return 30
        case "cron-link": return 40
        case "flat":
        case "tree": return variant === "mobile" ? 56 : 36
        default: return variant === "mobile" ? 60 : 48 // employee row (dynamic — measured)
      }
    },
    overscan: 5,
    enabled: shouldVirtualize,
  })

  const olderCount = focusMode === "tree" ? treeRows.olderCount : olderRows.length
  const olderLineLabel = useMemo(() => {
    const chats = olderCount
    return `Older · ${chats} ${chats === 1 ? "chat" : "chats"}`
  }, [olderCount])

  // Single source of truth for rendering a VirtualItem — shared by the
  // virtualized and plain render paths so they can never drift apart.
  const renderItem = (vi: VirtualItem): React.ReactNode => {
    switch (vi.kind) {
      case "terminals":
        return (
          <TerminalSectionHeader
            count={Math.max(counts[TERMINAL_GROUP] ?? 0, terminalRows.length)}
            hosts={terminalHosts?.enabled ? terminalHosts.hosts : []}
            onOpen={(id) => onSelect(id)}
            onOpenBeside={onOpenBeside}
          />
        )
      case "section":
        return (
          <div className="flex items-center gap-2 px-4 pb-1 pt-3">
            <span className={SECTION_LABEL_CLASS}>{vi.label}</span>
            {typeof vi.count === "number" && (
              <span className={SECTION_COUNT_CLASS}>{vi.count}</span>
            )}
          </div>
        )
      case "flat": {
        const Row = variant === "mobile" ? MobileSessionRow : FlatSessionRow
        return (
          <Row
            session={vi.row.session}
            avatarName={vi.row.avatarName}
            displayName={vi.row.displayName}
            hidePin={vi.hidePin}
            {...sharedRowProps}
          />
        )
      }
      case "tree": {
        const Row = variant === "mobile" ? MobileSessionRow : FlatSessionRow
        const { row, tree, hiddenSignal } = vi.visible
        const { node, depth, collapsed } = tree
        return (
          <Row
            session={row.session}
            avatarName={row.avatarName}
            displayName={row.displayName}
            tree={{
              depth,
              collapsed,
              hasChildren: node.children.length > 0,
              descendantCount: node.descendantCount,
              rootKind: depth === 0 ? node.rootKind : undefined,
              dispatchedRoot: depth === 0 && node.rootKind === "root" && isDispatchedRoot(row.session, employeeData),
              hiddenSignal,
              onToggle: toggleTreeCollapsed,
            }}
            {...sharedRowProps}
            onToggleSelect={toggleSelectTreeRow}
          />
        )
      }
      case "older-line":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2.5 text-left text-caption1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            <Clock3 className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{olderLineLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 -rotate-90" />
          </button>
        )
      case "pinned-more":
        return (
          <button
            onClick={togglePinnedExpanded}
            className="w-full cursor-pointer px-4 py-1.5 pl-12 text-left text-caption2 text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            {pinnedExpanded ? "Show fewer pinned" : `${pinnedRows.length - PINNED_VISIBLE} more pinned`}
          </button>
        )
      case "older-header":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
          >
            <span className={SECTION_LABEL_CLASS}>Older</span>
            <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{olderCount}</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
          </button>
        )
      case "employee":
        return (
          <EmployeeRow
            item={vi.item}
            variant={variant}
            expanded={expanded}
            handleEmployeeClick={handleEmployeeClick}
            handleMarkAllRead={handleMarkAllRead}
            onLoadMore={handleLoadMore}
            loadingMore={loadingMore}
            {...sharedRowProps}
          />
        )
      case "cron-link":
        // Scheduled sessions live on the Cron page — the chat list keeps only
        // this quiet doorway (individual runs stay reachable via search).
        return (
          <Link
            to="/cron"
            className="mt-1 flex w-full items-center gap-2 px-4 py-2.5 text-left text-caption1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            <CalendarClock className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Scheduled runs · {cronTotal.toLocaleString()}
            </span>
            <ChevronRight className="size-3.5 shrink-0" />
          </Link>
        )
      default:
        return null
    }
  }

  return (
    <div className="relative z-10 flex h-full flex-col bg-[var(--sidebar-bg)] shadow-[var(--shadow-card)]">
      {/* One slim control row — part of the List surface (--sidebar-bg), not
          the Thread. At rest it shows the Focused/All segmented control (left)
          + a borderless search icon (right); tapping search morphs the whole
          row into an inline search field. The page title and "+ New" live in
          the header pill. No hairlines at rest; the scroll-activated separator
          below is the only line. The band owns its own top safe-area inset:
          the chat route is `chromeless`, so PageLayout reserves none. */}
      <div
        data-chat-list-controls
        className={cn(
          "shrink-0 bg-[var(--sidebar-bg)] px-3 pb-2 pt-[max(var(--safe-top),8px)] transition-shadow duration-150",
          listScrolled && "shadow-[0_1px_0_0_var(--separator)]",
        )}
      >
        {/* Selection bar — replaces the resting/search band while a batch is
            being assembled. Archive and Delete are disabled at zero selected
            rather than hidden, so the actions never move under the finger. */}
        {selectionMode ? (
          <div className="flex h-9 items-center gap-1">
            <button
              onClick={exitSelection}
              aria-label="Cancel selection"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-[18px]" />
            </button>
            <span className="min-w-0 flex-1 truncate text-subheadline text-[var(--text-secondary)]">
              {selectedIds.size === 0 ? "Select chats" : `${selectedIds.size} selected`}
            </span>
            <button
              onClick={handleBulkArchive}
              disabled={selectedIds.size === 0}
              title="Archive selected chats"
              aria-label="Archive selected chats"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <Archive className="size-[17px]" aria-hidden />
            </button>
            <button
              onClick={() => setDeleteTarget({
                type: "bulk",
                id: "bulk",
                label: `${selectedIds.size} selected`,
                sessions: sessions.filter((s) => selectedIds.has(s.id)),
              })}
              disabled={selectedIds.size === 0}
              title="Delete selected chats"
              aria-label="Delete selected chats"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--system-red)] transition-colors hover:bg-[color-mix(in_srgb,var(--system-red)_12%,transparent)] disabled:pointer-events-none disabled:opacity-40"
            >
              <Trash2 className="size-[17px]" aria-hidden />
            </button>
          </div>
        ) : null}
        <div className={cn("relative flex h-9 items-center", selectionMode && "hidden")}>
          {/* Resting controls — fade/disable while the search field is open. */}
          <div
            className={cn(
              "flex w-full items-center gap-2 transition-opacity duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
            )}
            aria-hidden={searchOpen}
          >
            {/* Focused (default) shows only the operator's own top-level chats;
                All reveals delegated/automated sessions too. Persisted; search
                spans everything regardless. */}
            <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5">
              {([
                { mode: "focused", Icon: Focus, aria: "Focused", tip: "Only chats you started" },
                { mode: "all", Icon: Layers, aria: "All", tip: "Include automated & delegated sessions" },
                { mode: "tree", Icon: ListTree, aria: "Tree", tip: "Nest each session under the one that started it" },
              ] as const).map(({ mode, Icon, aria, tip }) => (
                <button
                  key={mode}
                  onClick={() => selectFocusMode(mode)}
                  aria-pressed={focusMode === mode}
                  aria-label={aria}
                  title={tip}
                  className={cn(
                    "flex items-center justify-center rounded-full px-2.5 py-1.5 transition-all",
                    focusMode === mode
                      ? "bg-[var(--bg-secondary)] text-foreground shadow-[var(--shadow-subtle)]"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="size-[15px]" strokeWidth={2} />
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {/* GRS-022 — new-chat (compose) in the chat LIST header. It remains
                available on desktop when a multi-pane grid retires the thread
                header pill, and owns the same action on the mobile list.
                This is one shared action across both responsive surfaces.
                GRS-023b — sits BEFORE search (order swapped per operator). */}
            <button
              onClick={onNewChat}
              title="New chat"
              aria-label="New chat"
              className="inline-flex size-11 lg:size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <SquarePen className="size-[18px]" />
            </button>

            <button
              onClick={() => setSearchOpen(true)}
              title="Search chats"
              aria-label="Search chats"
              className="inline-flex size-11 lg:size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <Search className="size-[18px]" />
            </button>

            {/* Enter multi-select. The batch actions themselves live in the
                bar below, so this row stays one affordance wide. */}
            <button
              onClick={() => { setSearchOpen(false); setSearch(""); setSelectionMode(true) }}
              title="Select chats"
              aria-label="Select chats"
              className="inline-flex size-11 lg:size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <ListChecks className="size-[18px]" />
            </button>
          </div>

          {/* Inline search field — morphs in from the right (width + opacity). */}
          <div
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-2 overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] transition-[width,opacity] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "w-full px-3 opacity-100" : "w-0 px-0 opacity-0",
            )}
          >
            <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <input
              id="chat-search"
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  closeSearch()
                }
              }}
              placeholder="Search chats"
              aria-label="Search chats"
              tabIndex={searchOpen ? 0 : -1}
              className="min-w-0 flex-1 bg-transparent text-subheadline text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
            />
            <button
              onClick={closeSearch}
              tabIndex={searchOpen ? 0 : -1}
              aria-label="Close search"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Home widgets — the app's home surface is this rail, on both the desktop
          list and the phone's home screen. Below the control band and above the
          chats, so a widget never pushes the search affordance off the top. */}
      <Slot
        area={AREAS.homeWidgets}
        variant="pane"
        className="shrink-0 flex flex-col gap-2 px-3 pb-2"
      />

      <div className="relative min-h-0 flex-1">
        {/* C10: short top scrim so rows dissolve under the header instead of
            clipping at a hard seam (the header border is gone). Theme-aware. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3"
          style={{ background: "linear-gradient(to bottom, var(--sidebar-bg), transparent)" }}
        />
        <div ref={scrollContainerRef} data-chat-list-scroll data-scrollable onScroll={handleListScroll} className="h-full overflow-y-auto pb-[calc(49px+var(--safe-bottom))] lg:pb-0">
        {loading ? (
          <div className="px-4 py-8 text-center text-caption1 text-[var(--text-quaternary)]">
            Loading chats…
          </div>
        ) : virtualItems.length === 0 ? (
          <div className="px-4 py-8 text-center text-caption1 text-[var(--text-quaternary)]">
            {search.trim() ? (
              "No matching chats"
            ) : focusMode === "focused" && hiddenAutomated > 0 ? (
              <>
                No personal chats here.{" "}
                <button onClick={() => selectFocusMode("all")} className="text-[var(--accent)] hover:underline">
                  View all ({hiddenAutomated} automated)
                </button>
              </>
            ) : (
              "No chats yet"
            )}
          </div>
        ) : shouldVirtualize ? (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const vi = virtualItems[vr.index]
              return (
                <div
                  key={vr.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={vr.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vr.start}px)` }}
                >
                  {renderItem(vi)}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            {virtualItems.map((vi, i) => (
              <React.Fragment key={
                vi.kind === "flat" ? vi.row.session.id
                : vi.kind === "tree" ? `tree:${vi.visible.row.session.id}`
                : vi.kind === "employee" ? vi.item.pinKey
                : vi.kind === "section" ? `section:${vi.id}`
                : `${vi.kind}:${i}`
              }>
                {renderItem(vi)}
              </React.Fragment>
            ))}
          </>
        )}

        {/* Contactable roster tail (employees with zero sessions). In All mode
            it continues the Team directory above, so the header renders only
            in Focused mode. Rows share the flat-row grammar: small emoji,
            single quiet line, a + affordance. */}
        {!loading && onContactEmployee && contactableEmployees.length > 0 ? (
          <div className="mt-3 pt-1">
            {focusMode !== "focused" ? null : (
              <SectionLabel label="Team" count={contactableEmployees.length} />
            )}
            {contactableEmployees.map((emp) => (
              <button
                key={emp.name}
                onClick={() => onContactEmployee(emp.name)}
                title={`Start a chat with ${emp.displayName || titleCase(emp.name)}${emp.department ? ` · ${emp.department}` : ""}`}
                className="group/contact relative flex w-full items-center gap-2.5 border-l-2 border-l-transparent py-[7px] pl-3.5 pr-3 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
              >
                <span className="relative flex size-[22px] shrink-0 items-center justify-center">
                  <EmployeeAvatar name={emp.name} size={22} />
                </span>
                <span className="min-w-0 flex-1 truncate text-subheadline text-[var(--text-secondary)]">
                  {emp.displayName || titleCase(emp.name)}
                </span>
                <Plus className="size-3.5 shrink-0 text-[var(--text-quaternary)] transition-colors group-hover/contact:text-[var(--accent)]" />
              </button>
            ))}
          </div>
        ) : null}
        </div>
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent showCloseButton={false} className="max-w-sm" onOpenAutoFocus={(e) => { e.preventDefault(); deleteButtonRef.current?.focus() }}>
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.type === "employee"
                ? `Delete all chats with "${deleteTarget.label}"?`
                : deleteTarget?.type === "bulk"
                  ? `Delete ${deleteTarget.sessions?.length ?? 0} selected chats?`
                  : `Delete "${deleteTarget?.label}"?`}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === "employee"
                ? `This will permanently delete ${deleteTarget.sessions?.length ?? 0} session(s) and all their messages. This cannot be undone.`
                : deleteTarget?.type === "bulk"
                  ? `This will permanently delete ${deleteTarget.sessions?.length ?? 0} session(s) and all their messages. This cannot be undone.`
                  : "This will permanently delete the session and all its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                if (deleteTarget.type === "employee" && deleteTarget.sessions) {
                  handleDeleteEmployee(deleteTarget.id, deleteTarget.sessions)
                } else if (deleteTarget.type === "bulk") {
                  handleBulkDelete(deleteTarget.sessions ?? [])
                } else {
                  handleDelete(deleteTarget.id)
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
