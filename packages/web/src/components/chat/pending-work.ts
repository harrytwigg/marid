import { useEffect, useMemo, useState } from 'react'
import type { BackgroundActivity, DelegatedActivity } from '@/lib/api'

/** Background work quiet for this long no longer reads as in progress. */
export const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000

/** Whether the activity's last reported change is older than the stale window. */
export function isBackgroundActivityStale(activity: BackgroundActivity | null, nowMs: number): boolean {
  const lastActivityAt = activity?.lastActivityAt ? new Date(activity.lastActivityAt).getTime() : 0
  return lastActivityAt > 0 && nowMs - lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS
}

/** True when background work should be surfaced. Streams retain the stale
 *  backstop; a tracked monitor stays visible until its observed end signal. */
export function isBackgroundActivityVisible(
  activity: BackgroundActivity | null,
  nowMs: number,
): boolean {
  const streams = activity?.activeStreams ?? 0
  const monitors = activity?.activeMonitors ?? 0
  return monitors > 0 || (streams > 0 && !isBackgroundActivityStale(activity, nowMs))
}

/** "1 monitor", "2 sub-agents". */
export function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

/**
 * Work a finished turn left running that can still change its answer: the
 * engine's background sub-agents, its tracked background shell tasks, a re-run
 * of the model one of them woke, and employee sessions delegated below this
 * one. Model requests in flight are not counted on their own: a turn's tail
 * sends some after it ends, and they carry no answer.
 */
export interface PendingWork {
  delegated: number
  subAgents: number
  monitors: number
  rerun: boolean
  /** Nothing has been reported for the stale window. A monitor may never end
   *  (a dev server, a log tail), so a quiet one stops reading as imminent. */
  quiet: boolean
}

export function pendingWork(
  activity: BackgroundActivity | null,
  delegatedActivity: DelegatedActivity | null,
  nowMs: number,
): PendingWork | null {
  const work: PendingWork = {
    delegated: count(delegatedActivity?.activeSessions),
    subAgents: count(activity?.backgroundAgents),
    monitors: count(activity?.activeMonitors),
    rerun: activity?.backgroundRerun === true,
    quiet: isBackgroundActivityStale(activity, nowMs),
  }
  return work.delegated + work.subAgents + work.monitors > 0 || work.rerun ? work : null
}

function count(value: number | undefined): number {
  return Math.max(0, value ?? 0)
}

/** When the pending work's reading next changes with no new report: a monitor
 *  alone goes quiet at the end of the stale window. Null when nothing will. */
export function pendingWorkChangesAt(activity: BackgroundActivity | null, work: PendingWork | null): number | null {
  if (!work || work.quiet || !work.monitors || !activity?.lastActivityAt) return null
  const at = new Date(activity.lastActivityAt).getTime()
  return Number.isFinite(at) ? at + BACKGROUND_ACTIVITY_STALE_MS + 1 : null
}

function joinParts(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
}

/**
 * The caption under a finished turn's answer. "Final answer" only when nothing
 * the turn left running can still change it; otherwise it names what is
 * pending. A monitor alone that has gone quiet is reported as running rather
 * than waited on, so one that never ends does not promise an answer forever.
 */
export function answerCaption(outcome: string | undefined, work: PendingWork | null): string {
  if (outcome === 'error') return 'Turn failed'
  if (!work) return 'Final answer'
  const waitingOnOthers = work.delegated > 0 || work.subAgents > 0 || work.rerun
  if (!waitingOnOthers && work.quiet) return `${countLabel(work.monitors, 'monitor')} still running`
  return `Waiting on ${joinParts(pendingParts(work))}`
}

function pendingParts(work: PendingWork): string[] {
  const parts: string[] = []
  if (work.delegated) parts.push(countLabel(work.delegated, 'delegated task'))
  if (work.subAgents) parts.push(countLabel(work.subAgents, 'sub-agent'))
  if (work.monitors) parts.push(countLabel(work.monitors, 'monitor'))
  if (work.rerun) parts.push('a background re-run')
  return parts
}

/** The session's pending work, live: it follows the activity it is given and
 *  re-reads itself when a monitor goes quiet with nothing else reported. */
export function usePendingWork(
  activity: BackgroundActivity | null,
  delegatedActivity: DelegatedActivity | null,
): PendingWork | null {
  const [, rerender] = useState(0)
  const read = pendingWork(activity, delegatedActivity, Date.now())
  const changesAt = pendingWorkChangesAt(activity, read)
  useEffect(() => {
    if (changesAt === null) return
    const timer = window.setTimeout(() => rerender((n) => n + 1), Math.max(0, changesAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [changesAt])
  // A stable object per reading, so the one row that carries it re-renders
  // only when the reading changes. The key describes the reading in full.
  const key = read ? `${read.delegated}|${read.subAgents}|${read.monitors}|${read.rerun}|${read.quiet}` : ''
  return useMemo(() => read, [key])
}
