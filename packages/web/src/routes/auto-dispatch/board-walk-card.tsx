import { Link } from "react-router-dom"
import type { BoardWalkStatus, TickRecord } from "@/lib/api-auto-dispatch"
import { agoLabel } from "./format"

/**
 * The board walk at a glance: whether it runs and when, which actions are
 * switched on, and what its recent ticks did and why. Read-only — the rules
 * are prose in `board-walk.md`, edited as a file, and when it runs is its cron
 * job, run, rescheduled and switched off on the Cron page.
 */

const OUTCOME_COLOR: Record<TickRecord["outcome"], string> = {
  ok: "var(--text-secondary)",
  disabled: "var(--text-tertiary)",
  busy: "var(--text-tertiary)",
  "invalid-rules": "var(--system-red)",
  failed: "var(--system-red)",
}

function stateLabel(status: BoardWalkStatus): string {
  if (!status.exists) return "no rules file"
  if (!status.job) return "no cron job — runs only when started by hand"
  if (status.scheduled) return "scheduled"
  // Enabled but not armed: the scheduler refused its schedule or zone.
  return status.job.enabled ? "not scheduled — the cron job's schedule or zone is not valid" : "switched off"
}

function Settings({ status }: { status: BoardWalkStatus }) {
  const { settings, job } = status
  const off = Object.entries(settings.actions).filter(([, on]) => !on).map(([name]) => name)
  return (
    <div className="mt-[var(--space-2)] grid gap-[2px] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
      <p>
        <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{stateLabel(status)}</span>
        {status.running && <span className="ml-[var(--space-2)] text-[var(--accent)]">· ticking now</span>}
        {job && <span> · <code>{job.schedule}</code> ({job.timezone})</span>}
        <span> · {settings.employee}{settings.model ? ` on ${settings.model}` : ""}</span>
      </p>
      {job && (
        <p>
          Schedule: cron job{" "}
          <Link to={`/cron/${encodeURIComponent(job.id)}`} className="focus-ring rounded font-[var(--weight-semibold)] text-[var(--accent)] outline-none">{job.name}</Link>
          {" "}— run it now, change it or switch it off there.
        </p>
      )}
      <p>{off.length === 0 ? "Every action is on." : `Switched off: ${off.join(", ")}.`} Rules: <code>{status.path}</code></p>
      {status.retiredKeys.length > 0 && (
        <p>{status.retiredKeys.join(", ")} in board-walk.md {status.retiredKeys.length === 1 ? "is" : "are"} no longer read: the cron job schedules the walk.</p>
      )}
      {status.problems.length > 0 && (
        <p role="alert" className="text-[var(--system-red)]">{status.problems.join("; ")}</p>
      )}
    </div>
  )
}

function Tick({ tick, now }: { tick: TickRecord; now: number }) {
  const acted = tick.entries.filter((entry) => entry.workItemId)
  return (
    <li className="py-[var(--space-2)]" data-testid="tick-row">
      <div className="flex flex-wrap items-baseline gap-x-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <span title={new Date(tick.at).toLocaleString()}>{agoLabel(Date.parse(tick.at), now)}</span>
        <span>{tick.trigger}</span>
        <span style={{ color: OUTCOME_COLOR[tick.outcome] }}>{tick.outcome}</span>
        {tick.sessionId && <Link to={`/chat/${tick.sessionId}`} className="focus-ring rounded text-[var(--accent)] outline-none">turn</Link>}
      </div>
      <p className="mt-[2px] text-[length:var(--text-footnote)] text-[var(--text-primary)]">{tick.summary}</p>
      {tick.modelSummary && <p className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Model: {tick.modelSummary}</p>}
      {acted.length > 0 && (
        <ul className="mt-[2px] grid gap-[2px]">
          {acted.map((entry, index) => (
            <li key={`${entry.workItemId}-${index}`} className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
              <Link to={`/todos/${entry.workItemId}`} className="focus-ring rounded font-[var(--weight-semibold)] text-[var(--accent)] outline-none">{entry.workItemId}</Link>
              {" "}{entry.kind}{entry.outcome ? ` — ${entry.outcome}` : ""}: {entry.reason}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function BoardWalkCard({ status, ticks, absent, now }: { status: BoardWalkStatus | null; ticks: TickRecord[]; absent: boolean; now: number }) {
  return (
    <section data-testid="board-walk" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]">
      <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Board walk</h2>
      {absent || !status
        ? <p className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">The board walk is not running in this gateway.</p>
        : <Settings status={status} />}
      {ticks.length === 0 ? (
        <p className="mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No ticks yet.</p>
      ) : (
        <ul className="mt-[var(--space-3)] divide-y divide-[var(--separator)]">
          {ticks.map((tick) => <Tick key={`${tick.at}-${tick.trigger}`} tick={tick} now={now} />)}
        </ul>
      )}
    </section>
  )
}
