import { Link } from "react-router-dom"
import type { IdleCapacityStart } from "@/lib/api-idle-capacity"
import { agoLabel, formatMinutes } from "./format"

/**
 * Every Todo the loop has auto-started, newest first, read back from the
 * comment it left on each one (User Story 2). A row whose comment no
 * longer parses in full shows the fields it could recover and says so.
 */

function reading(start: IdleCapacityStart): string {
  const parts = [start.fiveHour, ...start.weekly].filter((window): window is NonNullable<typeof window> => !!window)
  return parts.map((window) => `${window.name} ${window.usedPercent}%, ${formatMinutes(window.minutesToReset)} to reset`).join(" · ")
}

export function HistoryList({ starts, now }: { starts: IdleCapacityStart[]; now: number }) {
  return (
    <section data-testid="history" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]">
      <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Started by the loop</h2>
      {starts.length === 0 ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          Nothing yet. Every start leaves a comment on its Todo, and this list is read from those.
        </p>
      ) : (
        <ul className="mt-[var(--space-3)] divide-y divide-[var(--separator)]">
          {starts.map((start) => (
            <li key={start.commentId} className="py-[var(--space-3)]" data-testid="history-row">
              <div className="flex flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
                <Link to={`/todos/${start.workItemId}`} className="focus-ring rounded text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent)] outline-none">
                  {start.workItemId}
                </Link>
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] text-[var(--text-primary)]">{start.title}</span>
                <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{start.status}</span>
              </div>
              <div className="mt-[var(--space-1)] flex flex-wrap gap-x-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                <span title={new Date(start.startedAt).toLocaleString()}>{agoLabel(Date.parse(start.startedAt), now)}</span>
                {start.tier && <span>{start.tier} tier{start.trigger ? `, ${start.trigger} trigger` : ""}</span>}
                {start.charged !== undefined && start.cap !== undefined && <span>{start.charged} of {start.cap} this window</span>}
                {start.sessionId && <span className="truncate">session {start.sessionId}</span>}
              </div>
              <div className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                {reading(start) || "reading not recorded"}
                {start.partial && <span className="ml-[var(--space-2)] text-[var(--system-orange)]">· comment edited; fields recovered where possible</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
