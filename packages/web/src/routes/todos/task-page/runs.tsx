import type { WorkItemRunHandoffWire, WorkItemRunOutcomeWire, WorkItemRunWire } from "@/lib/api"
import { formatRelativeTime } from "../util"

/* An attempt read back as lines in the one Activity
 * stream: where it started, and where it settled carrying its outcome and the
 * handoff a reviewer reads. It borrows the whisper's line grammar so an
 * attempt sorts in beside the audit events instead of arriving as a table of
 * its own. An OPEN attempt has only the start line and reads as in-flight (the
 * pulsing blue dot, "Running", no outcome word) because it has reported no
 * outcome and the stream must not invent one. Nothing here is editable — a run
 * is a record of what happened, not a property. */

const OUTCOME_LABEL: Record<WorkItemRunOutcomeWire, string> = {
  completed: "Completed",
  blocked: "Blocked",
  crashed: "Crashed",
  timed_out: "Timed out",
  abandoned: "Abandoned",
  rate_limited: "Rate limited",
}

/** The disc takes a colour only as the honest state it presents: green for an
 *  attempt that finished, red for one that died, neutral for one let go, and
 *  yellow for one the provider turned away — a wait, not a fault. */
const OUTCOME_TINT: Record<WorkItemRunOutcomeWire, string> = {
  completed: "var(--system-green)",
  blocked: "var(--system-orange)",
  crashed: "var(--system-red)",
  timed_out: "var(--system-orange)",
  abandoned: "var(--text-quaternary)",
  rate_limited: "var(--system-yellow)",
}

const NOTE_FIELDS: Array<{ key: "verification" | "retryNotes" | "residualRisk"; label: string }> = [
  { key: "verification", label: "Verified" },
  { key: "retryNotes", label: "Retry notes" },
  { key: "residualRisk", label: "Residual risk" },
]

export function RunStartLine({ run }: { run: WorkItemRunWire }) {
  const inFlight = run.outcome === null
  return (
    <RunLine
      testId={`run-start-${run.id}`}
      at={run.startedAt}
      disc={
        inFlight ? (
          <span className="size-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite] motion-reduce:animate-none" />
        ) : (
          <span className="size-1.5 rounded-full bg-[var(--fill-primary)]" />
        )
      }
    >
      <span className={`font-semibold ${inFlight ? "text-[var(--system-blue)]" : "text-[var(--text-secondary)]"}`}>
        {inFlight ? "Running" : "Run started"}
      </span>
      {inFlight && run.summary ? ` ${run.summary}` : null}
    </RunLine>
  )
}

export function RunEndLine({
  run,
  outcome,
  at,
}: {
  run: WorkItemRunWire
  outcome: WorkItemRunOutcomeWire
  /** The moment the attempt settled — the feed already resolved it, so the
   *  line never has to fall back to a time that is not the one it shows. */
  at: string
}) {
  return (
    <div>
      <RunLine
        testId={`run-end-${run.id}`}
        at={at}
        disc={<span className="size-1.5 rounded-full" style={{ background: OUTCOME_TINT[outcome] }} />}
      >
        <span className="font-semibold text-[var(--text-secondary)]">{OUTCOME_LABEL[outcome]}</span>
        {run.summary ? ` ${run.summary}` : null}
      </RunLine>
      <RunHandoff id={run.id} handoff={run.handoff} error={run.error} />
    </div>
  )
}

/** The shared line: icon gutter, one truncating sentence, trailing relative
 *  time — the same anatomy WhisperLine uses, so the two interleave cleanly. */
function RunLine({
  testId,
  at,
  disc,
  children,
}: {
  testId: string
  at: string
  disc: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 py-[7px] text-[12.5px] text-[var(--text-tertiary)]" data-testid={testId}>
      <span className="mr-1.5 grid w-4 flex-none place-items-center" aria-hidden>
        {disc}
      </span>
      <span className="min-w-0 truncate">{children}</span>
      <span className="flex-none text-[var(--text-quaternary)]">· {formatRelativeTime(at)}</span>
    </div>
  )
}

function RunHandoff({
  id,
  handoff,
  error,
}: {
  id: string
  handoff: WorkItemRunHandoffWire
  error: string | null
}) {
  const files = handoff.changedFiles ?? []
  const notes = NOTE_FIELDS.filter((field) => handoff[field.key])
  if (!error && files.length === 0 && notes.length === 0) return null
  return (
    <dl data-testid={`run-handoff-${id}`} className="mb-1 pl-[30px] text-[12.5px] leading-[1.45]">
      {error && (
        <HandoffField label="Error">
          <span className="text-[var(--system-red)]">{error}</span>
        </HandoffField>
      )}
      {files.length > 0 && (
        <HandoffField label="Changed">
          <span className="flex min-w-0 flex-col">
            {files.map((file) => (
              <span
                key={file}
                title={file}
                className="truncate text-[11.5px] text-[var(--text-tertiary)]"
                style={{ fontFamily: "var(--font-code)" }}
              >
                {file}
              </span>
            ))}
          </span>
        </HandoffField>
      )}
      {notes.map((field) => (
        <HandoffField key={field.key} label={field.label}>
          {handoff[field.key]}
        </HandoffField>
      ))}
    </dl>
  )
}

function HandoffField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5 py-[1px]">
      <dt className="w-[76px] flex-none text-[var(--text-quaternary)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[var(--text-secondary)]">{children}</dd>
    </div>
  )
}
