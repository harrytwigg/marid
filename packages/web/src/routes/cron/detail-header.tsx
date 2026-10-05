import { Link, useNavigate } from "react-router-dom"
import { Check, ChevronLeft, Play } from "lucide-react"
import { describeCron } from "@/lib/cron-utils"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { ToggleSwitch, type CronJobWire } from "./shared"
import { CronDeleteMenu } from "./delete-menu"

function CronBackLink() {
  return (
    <Link
      to="/cron"
      className="mb-3.5 inline-flex items-center gap-1 text-[length:var(--text-footnote)] font-medium text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
    >
      <ChevronLeft size={13} strokeWidth={2.4} aria-hidden />
      Cron
    </Link>
  )
}

function CronJobSubtitle({ job }: { job: CronJobWire }) {
  return (
    <>
      <p className="text-[length:var(--text-subheadline)] leading-[var(--leading-normal)] text-[var(--text-secondary)]">
        {describeCron(job.schedule)}
        {job.timezone ? ` · ${job.timezone}` : ""}
      </p>
      <div
        className="mt-2.5 text-[length:var(--text-caption1)] leading-[1.7] text-[var(--text-quaternary)] [overflow-wrap:anywhere]"
        style={{ fontFamily: "var(--font-code)" }}
      >
        {job.schedule}
        <br />
        id: {job.id}
      </div>
    </>
  )
}

function CronJobTrailing({
  job,
  triggerPending,
  triggered,
  onRun,
  onToggle,
}: {
  job: CronJobWire
  triggerPending: boolean
  triggered: boolean
  onRun: () => void
  onToggle: (enabled: boolean) => void
}) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-none items-center gap-3.5">
      <button
        type="button"
        data-testid="cron-run-now"
        disabled={triggerPending || triggered}
        onClick={onRun}
        className="inline-flex h-[38px] flex-none items-center gap-1.5 rounded-full px-4 text-[length:var(--text-subheadline)] font-semibold transition-transform hover:scale-[0.98] disabled:opacity-80"
        style={
          triggered
            ? { background: "color-mix(in srgb, var(--system-green) 13%, transparent)", color: "var(--system-green)", boxShadow: "var(--inset-shine)" }
            : { background: "var(--accent-fill)", color: "var(--accent)", boxShadow: "var(--inset-shine)" }
        }
      >
        {triggered ? (
          <>
            <Check className="size-[15px]" aria-hidden />
            Triggered
          </>
        ) : (
          <>
            <Play className="size-[13px]" fill="currentColor" strokeWidth={0} aria-hidden />
            {triggerPending ? "Starting…" : "Run now"}
          </>
        )}
      </button>
      <ToggleSwitch
        checked={job.enabled}
        onChange={onToggle}
        label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
      />
      <CronDeleteMenu job={job} variant="header" onDeleted={() => navigate("/cron")} />
    </div>
  )
}

export function CronJobHeader({
  job,
  triggerPending,
  triggered,
  onRun,
  onToggle,
}: {
  job: CronJobWire | undefined
  triggerPending: boolean
  triggered: boolean
  onRun: () => void
  onToggle: (enabled: boolean) => void
}) {
  return (
    <LargeTitleHeader
      bodyGap={false}
      leading={<CronBackLink />}
      title={job?.name ?? "Cron"}
      subtitle={job ? <CronJobSubtitle job={job} /> : undefined}
      trailing={
        job ? (
          <CronJobTrailing
            job={job}
            triggerPending={triggerPending}
            triggered={triggered}
            onRun={onRun}
            onToggle={onToggle}
          />
        ) : null
      }
    />
  )
}
