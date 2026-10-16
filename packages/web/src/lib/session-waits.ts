/** `GET /api/sessions/:id/waits`: what a session's bottom-bar status is waiting on. Mirrors the
 *  gateway's response; the two sides change together. */
export interface SessionWaitsResponse {
  sessionId: string
  generatedAt: string
  items: SessionWaitItem[]
}

export type SessionWaitItem = BackgroundTaskWait | RerunWait | DelegatedSessionWait | HeartbeatWait

export interface BackgroundTaskWait {
  kind: 'monitor' | 'process' | 'subagent'
  id: string
  description: string | null
  command: string | null
  agentType: string | null
  startedAt: string
  lastOutput: { line: string; at: string } | null
  timeoutMs: number | null
}

export interface RerunWait {
  kind: 'rerun'
  startedAt: string | null
}

export type SessionWaitRelation = 'delegated' | 'review' | 'session'
export type SessionWaitStatus = 'running' | 'waiting' | 'idle' | 'error' | 'interrupted'

export interface DelegatedSessionWait {
  kind: 'session'
  sessionId: string
  /** The session it reports to: the response's own for a direct child. */
  reportsTo: string
  relation: SessionWaitRelation
  /** The caller may not read it: employee, title and todo are null and it is never linked. */
  restricted: boolean
  employee: string | null
  employeeDisplayName: string | null
  title: string | null
  todo: { id: string; title: string } | null
  status: SessionWaitStatus
  /** Holds engine capacity now. */
  active: boolean
  since: string
  /** Inactive only: when it stopped. */
  endedAt: string | null
  archived: boolean
}

export interface HeartbeatWait {
  kind: 'heartbeat'
  id: string
  message: string
  everySeconds: number
  nextFireAt: string
  fireCount: number
  maxFires: number | null
}

/** A session row that was in an earlier response and is not in the latest one. */
export interface GoneSessionWait {
  kind: 'gone'
  sessionId: string
  reportsTo: string
  active: boolean
}

export type WaitRow = SessionWaitItem | GoneSessionWait

/** A session row with the rows that report to it. */
export interface SessionNode {
  /** Unique among the rows shown: a restricted row has no id of its own to key by. */
  key: string
  row: DelegatedSessionWait | GoneSessionWait
  children: SessionNode[]
}

export interface WaitSections {
  /** Sessions still holding capacity (with whatever reports to them), then the rest of the waits. */
  waiting: { sessions: SessionNode[]; others: Exclude<SessionWaitItem, DelegatedSessionWait>[] }
  /** Finished, failed or stopped sessions the parent has not taken up yet. */
  finished: SessionNode[]
}

type SessionRow = DelegatedSessionWait | GoneSessionWait

/** What the gateway puts in place of the id of a session the caller may not read. Rows for several
 *  such sessions can share it, so it names none of them. */
export const HIDDEN_SESSION_ID = 'hidden'

/** A row whose id names exactly one session the caller can read. */
function hasRealId(row: SessionRow): boolean {
  return row.kind === 'gone' || (!row.restricted && row.sessionId !== HIDDEN_SESSION_ID)
}

function isSessionRow(row: WaitRow): row is SessionRow {
  return row.kind === 'session' || row.kind === 'gone'
}

/**
 * Session rows that left the response since the popup opened stay in as `gone` rows until it
 * closes. `known` is every session row seen so far, keyed by id, and is updated in place.
 */
export function retainGoneSessions(
  items: SessionWaitItem[],
  known: Map<string, DelegatedSessionWait | GoneSessionWait>,
): WaitRow[] {
  const present = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'session' || !hasRealId(item)) continue
    present.add(item.sessionId)
    known.set(item.sessionId, item)
  }
  const rows: WaitRow[] = [...items]
  for (const [sessionId, last] of known) {
    if (present.has(sessionId)) continue
    const gone: GoneSessionWait = { kind: 'gone', sessionId, reportsTo: last.reportsTo, active: last.active }
    known.set(sessionId, gone)
    rows.push(gone)
  }
  return rows
}

function buildTree(sessions: SessionRow[], rootId: string): SessionNode[] {
  const nodes: SessionNode[] = sessions.map((row, index) => ({
    key: hasRealId(row) ? row.sessionId : `${HIDDEN_SESSION_ID}:${index}`,
    row,
    children: [],
  }))
  const byId = new Map(nodes.filter((node) => hasRealId(node.row)).map((node) => [node.row.sessionId, node]))
  const roots: SessionNode[] = []
  for (const node of nodes) {
    // Nothing nests under a session that is not named, or that is not in the list (its link in the
    // chain has ended): such a row is shown at the top.
    const parentId = node.row.reportsTo
    const parent = parentId === rootId || parentId === HIDDEN_SESSION_ID ? undefined : byId.get(parentId)
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

function subtreeActive(node: SessionNode): boolean {
  return node.row.active || node.children.some(subtreeActive)
}

/** Group the rows the way the popup shows them: a session lands in "Finished" only when nothing
 *  under it is still working, so a grandchild is never separated from the row it reports to. */
export function sectionWaits(rows: WaitRow[], rootId: string): WaitSections {
  const roots = buildTree(rows.filter(isSessionRow), rootId)
  const others = rows.filter((row): row is Exclude<SessionWaitItem, DelegatedSessionWait> => !isSessionRow(row))
  return {
    waiting: { sessions: roots.filter(subtreeActive), others },
    finished: roots.filter((node) => !subtreeActive(node)),
  }
}

const STATUS_LABELS: Record<SessionWaitStatus, string> = {
  running: 'Running',
  waiting: 'Waiting',
  idle: 'Finished',
  error: 'Failed',
  interrupted: 'Stopped',
}

export function waitStatusLabel(status: SessionWaitStatus): string {
  return STATUS_LABELS[status] ?? status
}

const RELATION_LABELS: Record<SessionWaitRelation, string> = {
  delegated: 'Delegated task',
  review: 'Review',
  session: 'Session',
}

export function waitRelationLabel(relation: SessionWaitRelation): string {
  return RELATION_LABELS[relation] ?? 'Session'
}

/** "Alpha Lead" from `alpha-lead`, the fallback the bar's status uses. */
export function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** How long a span has run: "45s", "12m", "2h 5m", "3d". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

/** "every 10m" from a heartbeat's period. */
export function formatEvery(seconds: number): string {
  return formatElapsed(seconds * 1000)
}
