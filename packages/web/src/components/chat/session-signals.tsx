import { useSyncExternalStore } from "react"
import { type BackgroundActivity, type DelegatedActivity } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface Session {
  id: string
  connector?: string | null
  employee?: string
  title?: string
  status?: string
  source?: string
  sourceRef?: string
  sessionKey?: string
  /** Set on delegated/spawned child sessions; null/empty for top-level chats. */
  parentSessionId?: string | null
  transportState?: string
  queueDepth?: number
  lastActivity?: string
  createdAt?: string
  archivedAt?: string | null
  /** Background work (subagents/background tasks) still running while the
   *  session is officially idle. null/absent = none. Kept live via the
   *  session:background WS event (cache patch in useQueryInvalidation). */
  backgroundActivity?: BackgroundActivity | null
  /** Active descendant employee sessions; derived by the gateway. */
  delegatedActivity?: DelegatedActivity | null
  /** The in-flight turn has produced nothing for a while; derived by the gateway.
   *  A running session and a wedged one are otherwise indistinguishable. */
  turnProgress?: { lastProgressAt: number; awaitingSubmit: boolean; waitingForTerminalTurn?: boolean } | null
  [key: string]: unknown
}

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000
// A red error dot is only worth surfacing while the failure is fresh; older
// errored sessions fall back to the normal idle/unread treatment so the list
// isn't littered with stale red dots.
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

/** An archived search result is intentionally selectable so its transcript can
 * be reviewed and restored, despite being absent from default browse lists. */
export function isArchivedSession(session: Pick<Session, "archivedAt"> | { archivedAt?: unknown }): boolean {
  return typeof session.archivedAt === "string" && session.archivedAt.length > 0
}

const formatTimeCache = new Map<string, string>()
const FORMAT_TIME_CACHE_MAX = 200

export function formatTime(dateStr?: string): string {
  if (!dateStr) return ""
  const cached = formatTimeCache.get(dateStr)
  if (cached !== undefined) return cached
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  let result: string
  if (diff < 60_000) result = "now"
  else if (diff < 3_600_000) result = `${Math.floor(diff / 60_000)}m`
  else if (diff < 86_400_000) {
    result = new Date(dateStr).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } else if (diff < 172_800_000) result = "yesterday"
  else result = new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (formatTimeCache.size >= FORMAT_TIME_CACHE_MAX) {
    const oldest = formatTimeCache.keys().next().value
    if (oldest !== undefined) formatTimeCache.delete(oldest)
  }
  formatTimeCache.set(dateStr, result)
  return result
}

export function getSessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

function hasLiveStreams(activity: BackgroundActivity | null | undefined): boolean {
  if ((activity?.activeStreams ?? 0) <= 0) return false
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  const stale = lastActivityAt > 0 && Date.now() - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
  return !stale
}

/** Idle-but-busy: the session's turn ended but subagents/background tasks are
 *  still making API calls. Running/error status always wins over this. */
export function hasBackgroundActivity(session: Pick<Session, "status" | "backgroundActivity" | "delegatedActivity">): boolean {
  if (session.status === "running" || session.status === "error") return false
  return hasLiveStreams(session.backgroundActivity) || (session.delegatedActivity?.activeSessions ?? 0) > 0
}

export interface StatusDotState {
  color: string
  label: string
  pulse: boolean
}

/** A red error dot fires only for a *recently* errored session — `status` is
 *  "error" AND its last activity is inside the recency window. `nowMs` is passed
 *  in (rather than read at module load) so the window is evaluated at call time
 *  and the helper stays pure/testable. A missing or unparseable timestamp is
 *  treated as not-recent so the row falls through to the quiet treatment. */
export function isRecentError(
  status: string | undefined,
  lastActivityISO: string,
  nowMs: number,
): boolean {
  if (status !== "error") return false
  if (!lastActivityISO) return false
  const ts = new Date(lastActivityISO).getTime()
  if (Number.isNaN(ts)) return false
  return nowMs - ts < RECENT_ERROR_WINDOW_MS
}

/** How long a live turn may produce nothing before the row says so. Well below the
 *  gateway reconciler's kill threshold on purpose: the operator should see a session
 *  go amber — and get the chance to interrupt or resend it themselves — long before
 *  anything is reclaimed automatically. */
export const TURN_STALL_VISIBLE_MS = 90_000

/** Read stall state off a session, tolerating older payloads (a gateway that
 *  predates the field simply never reports progress).
 *
 *  The staleness verdict lives HERE, not on the server. A stalled session emits no
 *  events, so nothing invalidates the sessions query — a server-side verdict would
 *  only arrive if something unrelated triggered a refetch, and the whole point is
 *  to surface a session that generates no signals. The client receives the progress
 *  instant at turn start, while the session is still healthy, and `useStallClock`
 *  re-renders on a timer so this crosses the threshold with no network round-trip. */
export function getTurnStall(
  session: Session,
  now: number = Date.now(),
): { stalledForMs: number; awaitingSubmit: boolean } | null {
  const progress = session.turnProgress
  const at = progress?.lastProgressAt
  if (!progress || typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null
  // Waiting behind a turn typed in the terminal is a known state, not silence.
  if (progress.waitingForTerminalTurn) return null
  const stalledForMs = now - at
  if (stalledForMs < TURN_STALL_VISIBLE_MS) return null
  return { stalledForMs, awaitingSubmit: !!progress.awaitingSubmit }
}

/** One interval for the whole sidebar, shared via an external store.
 *
 *  A per-row timer would mean one interval per session; this keeps a single timer
 *  that only runs while something is subscribed, and only exists to re-render so
 *  getTurnStall can re-evaluate its own clock. */
const stallClock = (() => {
  const listeners = new Set<() => void>()
  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (!timer) {
        // The clock stops with the last listener, so the cached value can be
        // arbitrarily old by the time the sidebar mounts again. React re-reads the
        // snapshot right after subscribing, so refreshing here is picked up.
        now = Date.now()
        timer = setInterval(() => {
          now = Date.now()
          for (const l of listeners) l()
        }, 15_000)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    get: () => now,
  }
})()

/** Ticks only for rows that could actually stall. A row with nothing in flight has
 *  no age to advance, so it stays out of the listener set entirely and the interval
 *  does not exist at all while the list is quiet. */
const noStallClock = () => () => {}
export function useStallClock(active = true): number {
  return useSyncExternalStore(active ? stallClock.subscribe : noStallClock, stallClock.get, stallClock.get)
}

/** Coarse elapsed label — "2m", "51m", "1h 4m". Deliberately low-precision: the
 *  operator needs to know it has been too long, not the exact second. */
export function formatStallAge(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "under a minute"
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/** The dot for a running session: waiting on the terminal, stalled, or working.
 *  A stalled turn must not look like a working one. Same blue-dot spinner for
 *  both is exactly why a 51-minute hang can sit unnoticed: amber + an elapsed
 *  count is the difference between "thinking" and "go look at this". */
/** A session the gateway reports running on its background sub-agents says how many. */
function runningLabel(session: Session): string {
  const subagents = session.backgroundActivity?.backgroundAgents ?? 0
  return subagents > 0 ? `running · ${subagents} sub-agent${subagents === 1 ? "" : "s"}` : "running"
}

function runningStatusDot(session: Session, now: number): StatusDotState {
  if (session.turnProgress?.waitingForTerminalTurn) {
    return { color: "var(--system-blue)", label: "waiting for the turn typed in the terminal", pulse: false }
  }
  const stall = getTurnStall(session, now)
  if (!stall) return { color: "var(--system-blue)", label: runningLabel(session), pulse: true }
  return {
    color: "var(--system-orange)",
    label: stall.awaitingSubmit
      ? `prompt not accepted by the engine (stuck ${formatStallAge(stall.stalledForMs)})`
      : `no output for ${formatStallAge(stall.stalledForMs)}`,
    pulse: false, // a still dot reads as stuck; pulsing reads as working
  }
}

// Resolve the attention-state dot for a session. Returns null for the resting
// "read" state so no dot is painted (quiet at rest). Optionally treat the row
// as unread even when this session is read (e.g. a grouped employee row whose
// other chats are unread).
export function getStatusDot(
  session: Session,
  readSet: Set<string>,
  forceUnread = false,
  now: number = Date.now(),
): StatusDotState | null {
  if (session.status === "running") return runningStatusDot(session, now)
  if (isRecentError(session.status, getSessionActivity(session), Date.now())) {
    return { color: "var(--system-red)", label: "error", pulse: false }
  }
  if (hasBackgroundActivity(session)) return { color: "var(--system-orange)", label: "background work running", pulse: true }
  // Unread uses a NEUTRAL dot (not --accent): accent is user-set and may be red,
  // which would read like an error. Calm grey stays visible without alarming.
  if (forceUnread || !readSet.has(session.id)) return { color: "var(--text-secondary)", label: "unread", pulse: false }
  return null
}

const NEUTRAL_CHIP = "shrink-0 rounded-sm bg-[var(--fill-secondary)] px-1 text-caption2 font-medium tabular-nums text-[var(--text-secondary)]"

function StallChip({ stall }: { stall: { stalledForMs: number; awaitingSubmit: boolean } }) {
  return (
    <span
      title={
        stall.awaitingSubmit
          ? "The engine never accepted this prompt. Open the CLI view to resend it, or interrupt the session."
          : `The turn is still in flight but has produced no output for ${formatStallAge(stall.stalledForMs)}.`
      }
      style={{ background: "color-mix(in srgb, var(--system-orange) 14%, transparent)" }}
      className="shrink-0 rounded-sm px-1 text-caption2 font-medium tabular-nums text-[var(--system-orange)]"
    >
      {stall.awaitingSubmit ? "not accepted" : `stalled ${formatStallAge(stall.stalledForMs)}`}
    </span>
  )
}

function QueuedChip({ queued }: { queued: number }) {
  return (
    <span title={`${queued} queued message${queued === 1 ? "" : "s"} waiting on this session`} className={NEUTRAL_CHIP}>
      {queued} queued
    </span>
  )
}

/** Row-level "this needs a look" chips.
 *
 *  Both facts here were previously unobservable: a wedged session rendered exactly
 *  like a working one indefinitely, and the queue piling up behind it was not shown
 *  at all — so the only way to find a stuck employee was to go looking for one.
 *  A message waiting behind a turn typed in the claude terminal gets its own chip:
 *  it is waiting, not stalled. */
function TerminalWaitChip() {
  return (
    <span
      title="A message is waiting for the turn typed in the terminal to finish. Stop cancels it; the terminal turn keeps running."
      className={NEUTRAL_CHIP}
    >
      waiting on terminal
    </span>
  )
}

function attentionOf(session: Session) {
  const running = session.status === "running"
  return {
    waiting: running && !!session.turnProgress?.waitingForTerminalTurn,
    stall: running ? getTurnStall(session) : null,
    queued: typeof session.queueDepth === "number" ? session.queueDepth : 0,
  }
}

export function SessionAttentionChips({ session }: { session: Session }) {
  const { waiting, stall, queued } = attentionOf(session)
  if (!stall && !waiting && queued <= 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {waiting ? <TerminalWaitChip /> : null}
      {stall ? <StallChip stall={stall} /> : null}
      {queued > 0 ? <QueuedChip queued={queued} /> : null}
    </span>
  )
}

export function StatusDot({
  color,
  pulse = false,
  className,
  title,
  ...rest
}: {
  color: string
  pulse?: boolean
  className?: string
  title?: string
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("shrink-0 rounded-full", pulse && "animate-sidebar-pulse", className)}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      {...rest}
      style={{
        background: color,
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  )
}
