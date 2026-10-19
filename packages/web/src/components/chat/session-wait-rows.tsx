import type { ReactNode } from 'react'
import { formatCountdown, formatRelativeTime } from '@/routes/todos/util'
import {
  HIDDEN_SESSION_ID,
  formatElapsed,
  formatEvery,
  titleCaseSlug,
  waitRelationLabel,
  waitStatusLabel,
  type BackgroundTaskWait,
  type DelegatedSessionWait,
  type GoneSessionWait,
  type HeartbeatWait,
  type RerunWait,
  type SessionNode,
  type SessionWaitStatus,
} from '@/lib/session-waits'

const ROW =
  'flex w-full items-start gap-2 rounded-[9px] px-2 py-1.5 text-left text-[length:var(--text-caption1)] text-[var(--text-primary)]'
const LINK_ROW =
  'cursor-pointer border-none bg-transparent outline-none transition-colors duration-150 hover:bg-[var(--fill-tertiary)] focus-visible:bg-[var(--fill-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]'
const MUTED = 'text-[var(--text-secondary)]'
const QUIET = 'text-[length:var(--text-caption2)] text-[var(--text-tertiary)]'

const STATUS_COLORS: Record<SessionWaitStatus, string> = {
  running: 'var(--system-blue)',
  waiting: 'var(--system-orange)',
  idle: 'var(--system-green)',
  error: 'var(--system-red)',
  interrupted: 'var(--text-tertiary)',
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 text-[length:var(--text-caption2)] font-[var(--weight-medium)] leading-[1.5]"
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {label}
    </span>
  )
}

/** "finished 2m ago", from the shared compact relative time. */
function finishedLabel(endedAt: string, now: number): string {
  const rel = formatRelativeTime(endedAt, now)
  if (!rel) return 'finished'
  if (rel === 'just now' || rel === 'Yesterday') return `finished ${rel.toLowerCase()}`
  return /^\d+[mhd]$/.test(rel) ? `finished ${rel} ago` : `finished ${rel}`
}

function sessionTime(row: DelegatedSessionWait, now: number): string {
  if (row.active || !row.endedAt) return sinceMs(row.since, now) ?? ''
  return finishedLabel(row.endedAt, now)
}

function sinceMs(iso: string | null, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : formatElapsed(now - t)
}

function SessionRowBody({ row, now }: { row: DelegatedSessionWait; now: number }) {
  const name = row.employeeDisplayName ?? (row.employee ? titleCaseSlug(row.employee) : 'Session')
  const detail = row.todo ? `${row.todo.id} · ${row.todo.title}` : row.title ?? 'Untitled session'
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate font-[var(--weight-medium)]">{row.restricted ? 'In another department' : name}</span>
          {row.restricted ? null : <span className={`shrink-0 ${QUIET}`}>{waitRelationLabel(row.relation)}</span>}
        </span>
        {row.restricted ? null : <span className={`block truncate ${MUTED}`} title={detail}>{detail}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="flex items-center gap-1">
          {row.archived ? <Chip label="Archived" color="var(--text-tertiary)" /> : null}
          <Chip label={waitStatusLabel(row.status)} color={STATUS_COLORS[row.status]} />
        </span>
        <span className={`tabular-nums ${QUIET}`}>{sessionTime(row, now)}</span>
      </span>
    </>
  )
}

export function SessionWaitRow({ row, now, onOpen }: {
  row: DelegatedSessionWait | GoneSessionWait
  now: number
  onOpen: (sessionId: string) => void
}) {
  if (row.kind === 'gone') {
    return <div data-testid="session-wait-row" data-state="gone" className={`${ROW} ${MUTED}`}>No longer available</div>
  }
  if (row.restricted || row.sessionId === HIDDEN_SESSION_ID) {
    return (
      <div data-testid="session-wait-row" data-state="restricted" className={ROW}>
        <SessionRowBody row={row} now={now} />
      </div>
    )
  }
  return (
    <button
      type="button"
      data-testid="session-wait-row"
      data-state="link"
      onClick={(event) => {
        event.stopPropagation()
        onOpen(row.sessionId)
      }}
      className={`${ROW} ${LINK_ROW}`}
    >
      <SessionRowBody row={row} now={now} />
    </button>
  )
}

/** A session row and, indented under it, the sessions that report to it. */
export function SessionTree({ nodes, now, onOpen, depth = 0 }: {
  nodes: SessionNode[]
  now: number
  onOpen: (sessionId: string) => void
  depth?: number
}) {
  return (
    <>
      {nodes.map((node) => (
        <li key={node.key} style={depth ? { paddingLeft: depth * 14 } : undefined}>
          <SessionWaitRow row={node.row} now={now} onOpen={onOpen} />
          {node.children.length ? (
            <ul className="m-0 list-none p-0">
              <SessionTree nodes={node.children} now={now} onOpen={onOpen} depth={1} />
            </ul>
          ) : null}
        </li>
      ))}
    </>
  )
}

function Lines({ title, kind, onOpen, children }: { title: string; kind: string; onOpen?: () => void; children: ReactNode }) {
  const body = (
    <span className="min-w-0 flex-1">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-[var(--weight-medium)]">{title}</span>
        <span className={`shrink-0 ${QUIET}`}>{KIND_LABELS[kind] ?? kind}</span>
      </span>
      {children}
    </span>
  )
  if (!onOpen) return <div data-testid="background-wait-row" data-kind={kind} className={ROW}>{body}</div>
  return (
    <button
      type="button"
      data-testid="background-wait-row"
      data-kind={kind}
      data-state="link"
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      className={`${ROW} ${LINK_ROW}`}
    >
      {body}
    </button>
  )
}

const KIND_LABELS: Record<string, string> = {
  monitor: 'Monitor',
  process: 'Background command',
  subagent: 'Sub-agent',
  rerun: 'Re-run',
  heartbeat: 'Heartbeat',
}

function Command({ command }: { command: string }) {
  return (
    <code
      className={`block truncate font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] ${MUTED}`}
      title={command}
    >
      {command}
    </code>
  )
}

const TASK_TITLES = { monitor: 'Monitor', process: 'Background command', subagent: 'Sub-agent' } as const

function taskMeta(item: BackgroundTaskWait, now: number): string {
  const running = sinceMs(item.startedAt, now)
  return [
    running ? `running for ${running}` : null,
    item.kind === 'monitor' && item.timeoutMs ? `timeout ${formatElapsed(item.timeoutMs)}` : null,
    item.kind === 'subagent' ? item.agentType : null,
  ].filter(Boolean).join(' · ')
}

/** A sub-agent row opens its conversation when the popup can show one. */
export function BackgroundTaskRow({ item, now, onOpenSubagent }: {
  item: BackgroundTaskWait
  now: number
  onOpenSubagent?: (item: BackgroundTaskWait) => void
}) {
  const meta = taskMeta(item, now)
  const open = item.kind === 'subagent' && onOpenSubagent ? () => onOpenSubagent(item) : undefined
  return (
    <Lines title={item.description ?? TASK_TITLES[item.kind]} kind={item.kind} onOpen={open}>
      {item.command ? <Command command={item.command} /> : null}
      {item.lastOutput ? (
        <span className={`block truncate ${MUTED}`} title={item.lastOutput.line}>
          {item.lastOutput.line}
        </span>
      ) : null}
      {meta ? <span className={`block ${QUIET}`}>{meta}</span> : null}
    </Lines>
  )
}

export function RerunRow({ item, now }: { item: RerunWait; now: number }) {
  const running = sinceMs(item.startedAt, now)
  return (
    <Lines title="Background re-run" kind="rerun">
      {running ? <span className={`block ${QUIET}`}>running for {running}</span> : null}
    </Lines>
  )
}

export function HeartbeatRow({ item, now }: { item: HeartbeatWait; now: number }) {
  const next = formatCountdown(item.nextFireAt, now)
  return (
    <Lines title={item.message} kind="heartbeat">
      <span className={`block ${QUIET}`}>
        {next ? `next in ${next}` : 'due now'}, every {formatEvery(item.everySeconds)}
      </span>
    </Lines>
  )
}
