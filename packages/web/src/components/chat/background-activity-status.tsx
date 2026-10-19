import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { BackgroundActivity, DelegatedActivity } from '@/lib/api'
import type { SubagentRef } from '@/lib/subagent-transcript'
import { SessionWaitsBoundary, WaitsNote } from '@/components/chat/session-waits-boundary'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { titleCaseSlug } from '@/lib/session-waits'
import { countLabel, isBackgroundActivityVisible, joinParts, pendingWork } from './pending-work'

const EXIT_MS = 140

/** The popup's code (rows, query, tick) only loads when the status is first opened. */
const SessionWaitsPopup = lazy(() => import('@/components/chat/session-waits-popup'))

interface ActivityCopy {
  kind: 'runtime' | 'delegated-one' | 'delegated-many' | 'delegated-generic'
  long: string
  short: string
  title: string
  count?: number
  /** The popup lists what this says: delegated sessions, or work the turn left running. Model
   *  requests in flight alone are not listed, so they leave the label a plain status. */
  listable: boolean
}

/** The runtime part of the line. Work the turn left running is counted as
 *  the answer caption counts it; model requests in flight with nothing else
 *  pending fall back to the in-flight agent count. */
function runtimeCopy(activity: BackgroundActivity | null, nowMs: number): { long: string; short: string; listable: boolean } {
  const work = pendingWork(activity, null, nowMs)
  if (work) {
    const parts = [
      ...(work.subAgents ? [countLabel(work.subAgents, 'sub-agent')] : []),
      ...(work.monitors ? [countLabel(work.monitors, 'monitor')] : []),
    ]
    if (!parts.length) return { long: 'Background re-run in progress', short: 'Re-running', listable: true }
    const short = [...parts, ...(work.rerun ? ['re-run'] : [])].join(' · ')
    return { long: `${joinParts([...parts, ...(work.rerun ? ['a re-run'] : [])])} in background`, short, listable: true }
  }
  const agents = activity?.activeAgents ?? activity?.activeStreams ?? 0
  if (agents > 0) return { long: `${countLabel(agents, 'agent')} in background`, short: countLabel(agents, 'agent'), listable: false }
  return { long: 'Background work in progress', short: 'Working', listable: false }
}

function activityCopy(
  activity: BackgroundActivity | null,
  delegatedActivity: DelegatedActivity | null,
  employeeDisplayNames: Record<string, string>,
): ActivityCopy | null {
  const delegatedSessions = delegatedActivity?.activeSessions ?? 0
  if (delegatedSessions > 0) {
    const employees = delegatedActivity?.employees ?? []
    const title = `${countLabel(delegatedSessions, 'delegated task')} still running`
    if (employees.length === 1) {
      const displayName = employeeDisplayNames[employees[0]] || titleCaseSlug(employees[0])
      return {
        kind: 'delegated-one',
        long: `${displayName} working`,
        short: `Working · ${displayName}`,
        title,
        listable: true,
      }
    }
    if (employees.length > 1) {
      return {
        kind: 'delegated-many',
        long: `${employees.length} employees working`,
        short: `${employees.length} working`,
        title,
        count: employees.length,
        listable: true,
      }
    }
    return {
      kind: 'delegated-generic',
      long: 'Delegated work in progress',
      short: 'Work in progress',
      title,
      listable: true,
    }
  }

  const nowMs = Date.now()
  if (!isBackgroundActivityVisible(activity, nowMs)) return null
  const { long, short, listable } = runtimeCopy(activity, nowMs)
  return {
    kind: 'runtime',
    long,
    short,
    title: 'Background work running after the turn ended',
    listable,
  }
}

/** Live `prefers-reduced-motion` flag; the fade collapses to an opacity swap. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    setReduce(mq.matches)
    const on = () => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/**
 * Idle-but-busy StateLine for the composer toolbar: the session's turn ended
 * but subagents or monitors are still running. Rendered in the toolbar's
 * flexible middle (between two flex-1 spacers), so appearing and disappearing
 * move NOTHING — ambient state never shifts the page. Purely
 * informational (input stays live); the parent hides it while a foreground
 * turn streams (the "Thinking" indicator owns that) and in the CLI view.
 *
 * With a session to ask about, the label is a button that opens a popup of what the session
 * is waiting on; the popup closes with the status.
 *
 * Orange is the system's background-work semantic (sidebar dot: blue =
 * foreground running, orange = background) — kept for cross-surface
 * consistency. Exit keeps the node mounted until the fade completes so
 * disappearance is a fade, not a pop.
 */
export function BackgroundActivityStatus({
  activity,
  delegatedActivity = null,
  employeeDisplayNames = {},
  sessionId = null,
  onOpenSubagent,
}: {
  activity: BackgroundActivity | null
  delegatedActivity?: DelegatedActivity | null
  employeeDisplayNames?: Record<string, string>
  sessionId?: string | null
  /** Shows a sub-agent's conversation, held by whoever outlives this status: without it a sub-agent row is plain text. */
  onOpenSubagent?: (agent: SubagentRef, returnFocusTo: HTMLElement | null) => void
}) {
  const currentCopy = activityCopy(activity, delegatedActivity, employeeDisplayNames)
  const active = currentCopy !== null
  const [rendered, setRendered] = useState(active)
  const [entered, setEntered] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const [popupOpen, setPopupOpen] = useState(false)
  // Stable: the popup's timers depend on it, and this component re-renders often.
  const closePopup = useCallback(() => setPopupOpen(false), [])
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  // Copy shown while exiting is frozen so the label does not flash to an idle
  // value during the fade-out.
  const [shownCopy, setShownCopy] = useState<ActivityCopy | null>(currentCopy)

  useEffect(() => {
    if (currentCopy) {
      setRendered(true)
      setShownCopy(currentCopy)
      // Enter on the next frame so the initial off-state paints and the fade runs.
      const r = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(r)
    }
    setEntered(false)
    if (!rendered) return
    const timer = window.setTimeout(() => setRendered(false), reducedMotion ? 1 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [active, currentCopy?.kind, currentCopy?.long, currentCopy?.short, currentCopy?.title, currentCopy?.listable, reducedMotion, rendered])

  // The popup goes with the status, and with anything it could list: it starts closing when the
  // fade-out does, or when only model requests in flight are left.
  const listable = currentCopy?.listable === true
  useEffect(() => {
    if (!listable) closePopup()
  }, [listable, closePopup])

  if (!rendered || !shownCopy) return null

  const renderLabel = (label: string) => {
    if (shownCopy.kind !== 'delegated-many' || shownCopy.count === undefined) return label
    const remainder = label.slice(String(shownCopy.count).length)
    return <><span data-activity-count className="tabular-nums">{shownCopy.count}</span>{remainder}</>
  }

  const label = (
    <>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--system-orange)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" />
      <span className="hidden min-w-0 truncate @min-[480px]/composer:inline">{renderLabel(shownCopy.long)}</span>
      <span className="min-w-0 truncate @min-[480px]/composer:hidden">{renderLabel(shownCopy.short)}</span>
    </>
  )

  return (
    <span
      role="status"
      title={shownCopy.title}
      data-testid="background-activity-status"
      className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)]"
      style={{
        opacity: entered ? 1 : 0,
        transform: reducedMotion ? undefined : entered ? 'translateY(0)' : 'translateY(2px)',
        transition: reducedMotion
          ? 'opacity 1ms linear'
          : `opacity ${entered ? 160 : EXIT_MS}ms var(--ease-smooth), transform ${entered ? 160 : EXIT_MS}ms var(--ease-smooth)`,
      }}
    >
      {sessionId && shownCopy.listable ? (
        <Popover open={popupOpen} onOpenChange={setPopupOpen}>
          <PopoverTrigger asChild>
            <button
              ref={triggerRef}
              type="button"
              data-pane-focus-preserving
              data-testid="background-activity-trigger"
              onPointerDown={(event) => event.stopPropagation()}
              className="-mx-1 inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-[6px] border-none bg-transparent px-1 py-0.5 font-[inherit] text-[length:inherit] text-inherit transition-colors duration-150 hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)] focus-visible:bg-[var(--fill-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              {label}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            aria-label="What this session is waiting on"
            data-pane-focus-preserving
            data-testid="session-waits-popup"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className="max-h-[min(60vh,420px)] w-[min(380px,calc(100vw-16px))] overflow-y-auto p-1.5"
          >
            <SessionWaitsBoundary>
              <Suspense fallback={<WaitsNote>Loading…</WaitsNote>}>
                <SessionWaitsPopup key={sessionId} sessionId={sessionId} onClose={closePopup} onOpenSubagent={onOpenSubagent && ((agent) => onOpenSubagent(agent, triggerRef.current))} />
              </Suspense>
            </SessionWaitsBoundary>
          </PopoverContent>
        </Popover>
      ) : label}
    </span>
  )
}
