import { useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronRight } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { sessionPath } from "@/components/chat/chat-route-helpers"
import type { HookRun } from "@/lib/api-hooks"
import { agoLabel } from "@/lib/cron-utils"
import { todoPath } from "@/lib/todo-id"
import { outcomeBadgeVariant } from "./format"
import { useHookRun } from "./use-hooks"

/** The run log's table: one row per action of a firing, newest first, each row
 *  openable onto the full payload and the command's output. */

const HEADINGS = ["Time", "Hook", "Todo", "Event", "Action", "Outcome", "Result"] as const

/** What a run's result column reads: the session a `spawn` started, a command's
 *  exit code, the failure text, or nothing. */
function Result({ run }: { run: HookRun }) {
  if (run.sessionId) {
    return (
      <Link to={sessionPath(run.sessionId)} className="text-[var(--accent)] hover:underline">
        session
      </Link>
    )
  }
  if (run.action === "command" && run.exitCode !== null) return <span>exit {run.exitCode}</span>
  if (run.error) return <span className="text-[var(--system-red)]">{run.error}</span>
  return <span className="text-[var(--text-quaternary)]">—</span>
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td className="px-2 py-2 align-top max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:px-3.5">
      <span className="hidden text-[length:var(--text-caption1)] text-[var(--text-tertiary)] max-sm:inline">{label}</span>
      <span className="min-w-0">{children}</span>
    </td>
  )
}

/** The expanded half of a row, read on first open from the single-run endpoint. */
function RunDetail({ runId, detailId, colSpan }: { runId: string; detailId: string; colSpan: number }) {
  const detail = useHookRun(runId)
  return (
    <tr id={detailId} className="max-sm:block">
      <td colSpan={colSpan} className="bg-[var(--fill-quaternary)] px-3.5 py-3 max-sm:block">
        {detail.isLoading ? (
          <Skeleton height={60} />
        ) : detail.data ? (
          <div className="grid gap-3">
            {detail.data.output != null && detail.data.output !== "" && (
              <div>
                <p className="mb-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">Output</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--material-thick)] p-2 text-[length:var(--text-caption1)]" style={{ fontFamily: "var(--font-code)" }}>{detail.data.output}</pre>
              </div>
            )}
            <div>
              <p className="mb-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">Payload</p>
              <pre data-testid="run-payload" className="overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--radius-md)] bg-[var(--material-thick)] p-2 text-[length:var(--text-caption1)]" style={{ fontFamily: "var(--font-code)" }}>{JSON.stringify(detail.data.payload ?? null, null, 2)}</pre>
            </div>
          </div>
        ) : (
          <p className="text-[length:var(--text-footnote)] text-[var(--system-red)]">Could not read this run.</p>
        )}
      </td>
    </tr>
  )
}

function RunRow({ run, now, expanded, controls, onToggle }: { run: HookRun; now: Date; expanded: boolean; controls: string; onToggle: () => void }) {
  return (
    <tr
      data-testid={`run-row-${run.id}`}
      className="border-t-[0.5px] border-[var(--separator)] max-sm:block max-sm:rounded-[13px] max-sm:border-0 max-sm:py-1"
    >
      <td className="px-2 py-2 align-top max-sm:px-3.5 max-sm:pt-2 max-sm:pb-0">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-expanded={expanded}
          aria-controls={expanded ? controls : undefined}
          aria-label={expanded ? `Hide details for ${run.hook}` : `Show details for ${run.hook}`}
          onClick={onToggle}
          className="text-[var(--text-tertiary)]"
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </Button>
      </td>
      <Cell label="Time">
        <span title={run.startedAt} className="text-[var(--text-secondary)]">{agoLabel(run.startedAt, now)}</span>
      </Cell>
      <Cell label="Hook">
        <span className="truncate text-[var(--text-primary)]">{run.hook}</span>
      </Cell>
      <Cell label="Todo">
        {run.todoId ? (
          <Link to={todoPath(run.todoId)} className="text-[var(--accent)] hover:underline">{run.todoId}</Link>
        ) : (
          <span className="text-[var(--text-quaternary)]">—</span>
        )}
      </Cell>
      <Cell label="Event">
        <span className="text-[var(--text-secondary)]">{run.event}</span>
      </Cell>
      <Cell label="Action">
        <span className="text-[var(--text-secondary)]">{run.action}</span>
      </Cell>
      <Cell label="Outcome">
        <Badge variant={outcomeBadgeVariant(run.status)}>{run.status}</Badge>
      </Cell>
      <Cell label="Result">
        <Result run={run} />
      </Cell>
    </tr>
  )
}

/** A row and, when open, its detail row — one fragment so the key follows the run. */
function RunEntry({ run, now, expanded, onToggle }: { run: HookRun; now: Date; expanded: boolean; onToggle: () => void }) {
  const detailId = `run-detail-${run.id}`
  return (
    <>
      <RunRow run={run} now={now} expanded={expanded} controls={detailId} onToggle={onToggle} />
      {expanded && <RunDetail runId={run.id} detailId={detailId} colSpan={HEADINGS.length + 1} />}
    </>
  )
}

export function RunTable({ runs, now }: { runs: readonly HookRun[]; now: Date }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="glass-card overflow-hidden rounded-[var(--radius-xl)]">
      <table aria-label="Hook run log" className="w-full border-collapse text-left text-[length:var(--text-footnote)] max-sm:block max-sm:p-2">
        <thead className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] max-sm:hidden">
          <tr className="border-b-[0.5px] border-[var(--separator)]">
            <th className="w-8 px-2 py-2" aria-label="Expand" />
            {HEADINGS.map((heading) => (
              <th key={heading} className="px-2 py-2 font-[var(--weight-medium)]">{heading}</th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {runs.map((run) => (
            <RunEntry
              key={run.id}
              run={run}
              now={now}
              expanded={expanded === run.id}
              onToggle={() => setExpanded((current) => (current === run.id ? null : run.id))}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
