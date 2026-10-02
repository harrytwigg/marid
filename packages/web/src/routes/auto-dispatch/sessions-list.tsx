import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { STARTED_BY_LABEL, type StartedSession } from "@/lib/api-auto-dispatch"
import { agoLabel } from "./format"

/**
 * Every session started on an engine, newest first, whatever started it — the
 * board walk, the dispatch button, cron, a delegation or a chat. Read from the
 * session registry, so there is no second record of a start to disagree with
 * the sessions themselves. One engine at a time; Claude first.
 */

const SHOWN = 50

function engines(sessions: readonly StartedSession[]): string[] {
  const names = [...new Set(sessions.map((session) => session.engine))]
  return names.sort((a, b) => (a === "claude" ? -1 : b === "claude" ? 1 : a.localeCompare(b)))
}

function EngineTabs({ engines, engine, onPick }: { engines: string[]; engine: string | undefined; onPick: (name: string) => void }) {
  if (engines.length < 2) return null
  return (
    <div role="tablist" aria-label="Engine" className="flex gap-[var(--space-1)]">
      {engines.map((name) => (
        <button
          key={name}
          role="tab"
          aria-selected={name === engine}
          onClick={() => onPick(name)}
          className={`focus-ring rounded-full px-[10px] py-[2px] text-[length:var(--text-caption1)] outline-none ${name === engine ? "bg-[var(--accent)] text-white" : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)]"}`}
        >
          {name}
        </button>
      ))}
    </div>
  )
}

function SessionRow({ session, now }: { session: StartedSession; now: number }) {
  return (
    <li className="py-[var(--space-2)]" data-testid="session-row">
      <div className="flex flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)]">
        <Link to={`/chat/${session.id}`} className="focus-ring min-w-0 flex-1 truncate rounded text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none hover:text-[var(--accent)]">
          {session.title ?? session.id}
        </Link>
        <span className={`text-[length:var(--text-caption1)] ${session.startedBy === "board-walk-dispatch" ? "font-[var(--weight-semibold)] text-[var(--system-green)]" : "text-[var(--text-secondary)]"}`}>
          {STARTED_BY_LABEL[session.startedBy]}
        </span>
      </div>
      <div className="mt-[2px] flex flex-wrap gap-x-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <span title={new Date(session.createdAt).toLocaleString()}>{agoLabel(Date.parse(session.createdAt), now)}</span>
        {session.employee && <span>{session.employee}</span>}
        {session.model && <span>{session.model}</span>}
        <span>{session.status}</span>
      </div>
    </li>
  )
}

export function SessionsList({ sessions, now }: { sessions: StartedSession[]; now: number }) {
  const available = useMemo(() => engines(sessions), [sessions])
  const [picked, setPicked] = useState<string | null>(null)
  const engine = picked && available.includes(picked) ? picked : available[0]
  const rows = sessions.filter((session) => session.engine === engine)
  return (
    <section data-testid="sessions" className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[var(--space-5)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)]">
        <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Sessions started this week</h2>
        <EngineTabs engines={available} engine={engine} onPick={setPicked} />
      </div>
      {rows.length === 0 ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No sessions started in the last week.</p>
      ) : (
        <ul className="mt-[var(--space-3)] divide-y divide-[var(--separator)]">
          {rows.slice(0, SHOWN).map((session) => <SessionRow key={session.id} session={session} now={now} />)}
        </ul>
      )}
      {rows.length > SHOWN && (
        <p className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">and {rows.length - SHOWN} more</p>
      )}
    </section>
  )
}
