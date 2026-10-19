import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight } from "@/components/ui/icon"
import { api } from "@/lib/api"
import { agoLabel, describeCron, formatNextRun, nextCronDate } from "@/lib/cron-utils"
import { Button } from "@/components/ui/button"
import { PageLayout } from "@/components/page-layout"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { CronListHeader } from "./list-header"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { WeeklySchedule } from "@/components/crons/weekly-schedule"
import {
  displayNameOf,
  filterJobs,
  groupJobsByEmployee,
  RunGlyph,
  runOutcome,
  runTimestamp,
  ToggleSwitch,
  type CronFilter,
  type CronJobWire,
} from "./shared"
import { CronDeleteMenu } from "./delete-menu"
import { ListSkeleton } from "./list-skeleton"
import { useCronViewParams, type CronLens } from "./use-cron-params"

/* design-cron §2 — Cron joins the shared language: inline large-title header
 * with true counts, a Jobs/Week segmented lens (Todos idiom, zero chrome
 * moves), grouped-inset containers per employee with flat hoverable rows, and
 * a row that answers everything at a glance — last-run outcome glyph, human
 * schedule, quiet mono expression, next fire, and the one-tap ToggleSwitch.
 * A row opens the job as a document (/cron/:id — the Skills idiom). The old
 * "Pipelines" card grid was an exact informational duplicate of this list and
 * is merged into it. */

type Lens = CronLens

function useEmployeesByName() {
  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg, staleTime: 60_000 })
  return useMemo(
    () => new Map((org.data?.employees ?? []).map((e) => [e.name, e])),
    [org.data],
  )
}

export function CronRow({
  job,
  now,
  onToggle,
  onOpen,
}: {
  job: CronJobWire
  now: Date
  onToggle: (job: CronJobWire, enabled: boolean) => void
  onOpen: (id: string) => void
}) {
  const outcome = runOutcome(job.lastRun)
  const lastTs = runTimestamp(job.lastRun)
  const ago = agoLabel(lastTs ?? undefined, now)
  const lastLabel =
    outcome === "error" ? `failed ${ago}` : ago ? `ran ${ago}` : "never ran"
  const next = useMemo(
    () => (job.enabled ? formatNextRun(nextCronDate(job.schedule, job.timezone ?? undefined, now), now) : ""),
    [job.enabled, job.schedule, job.timezone, now],
  )

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`cron-row-${job.id}`}
      onClick={() => onOpen(job.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen(job.id)
        }
      }}
      className="flex min-h-[56px] cursor-pointer items-center gap-2.5 rounded-[13px] py-2 pl-2.5 pr-3 transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)] focus-visible:bg-[var(--fill-quaternary)] focus-visible:outline-none"
    >
      <span style={job.enabled ? undefined : { opacity: 0.55 }} className="flex flex-none">
        <RunGlyph outcome={outcome} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]" style={job.enabled ? undefined : { opacity: 0.55 }}>
        <span className="truncate text-[length:var(--text-subheadline)] font-medium leading-[1.3] text-[var(--text-primary)]">
          {job.name}
        </span>
        <span className="flex min-w-0 items-center gap-[7px] whitespace-nowrap text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <span className="truncate">{describeCron(job.schedule)}</span>
          <span
            className="flex-none text-[11px] text-[var(--text-quaternary)] max-[500px]:hidden"
            style={{ fontFamily: "var(--font-code)" }}
          >
            {job.schedule}
          </span>
          <span
            className="flex-none"
            style={{ color: outcome === "error" ? "var(--system-red)" : "var(--text-quaternary)" }}
          >
            · {lastLabel}
          </span>
        </span>
      </span>
      {next && (
        <span
          className="flex-none text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)] max-[640px]:hidden"
          data-testid={`cron-next-${job.id}`}
        >
          next {next}
        </span>
      )}
      <ToggleSwitch
        checked={job.enabled}
        onChange={(v) => onToggle(job, v)}
        label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
      />
      <CronDeleteMenu job={job} variant="row" />
      <ChevronRight size={14} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
    </div>
  )
}

export default function CronPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { lens, setLens, filter, setFilter } = useCronViewParams()
  // Re-render tick so "updated Xm ago" / next-run labels stay honest.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const jobsQuery = useQuery({
    queryKey: ["cron-jobs"],
    queryFn: api.getCronJobs,
    refetchInterval: 60_000,
  })
  const jobs = useMemo(() => (jobsQuery.data ?? []) as unknown as CronJobWire[], [jobsQuery.data])
  const byName = useEmployeesByName()

  const toggle = useMutation({
    mutationFn: ({ job, enabled }: { job: CronJobWire; enabled: boolean }) =>
      api.updateCronJob(job.id, { enabled }),
    onMutate: async ({ job, enabled }) => {
      await qc.cancelQueries({ queryKey: ["cron-jobs"] })
      const prev = qc.getQueryData(["cron-jobs"])
      qc.setQueryData(["cron-jobs"], (old: unknown) =>
        Array.isArray(old) ? old.map((j) => ((j as CronJobWire).id === job.id ? { ...j, enabled } : j)) : old,
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(["cron-jobs"], ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["cron-jobs"] }),
  })
  const onToggle = useCallback(
    (job: CronJobWire, enabled: boolean) => toggle.mutate({ job, enabled }),
    [toggle],
  )
  const onOpen = useCallback((id: string) => navigate(`/cron/${encodeURIComponent(id)}`), [navigate])

  const enabledCount = useMemo(() => jobs.filter((j) => j.enabled).length, [jobs])
  const shown = useMemo(() => filterJobs(jobs, filter), [jobs, filter])
  const groups = useMemo(() => groupJobsByEmployee(shown), [shown])
  const updatedAgo = jobsQuery.dataUpdatedAt ? agoLabel(jobsQuery.dataUpdatedAt, now) : ""

  const filters: { id: CronFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: jobs.length },
    { id: "enabled", label: "Enabled", count: enabledCount },
    { id: "disabled", label: "Disabled", count: jobs.length - enabledCount },
  ]

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="840px"
        header={
          <CronListHeader
            subtitle={
              jobsQuery.isSuccess
                ? `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} · ${enabledCount} enabled`
                : "Scheduled work your company runs on its own"
            }
            updatedAgo={updatedAgo}
            fetching={jobsQuery.isFetching}
            onRefresh={() => void jobsQuery.refetch()}
          />
        }
      >
        <div>
          {/* Lens control — fixed geometry, only the region below swaps. */}
          <div className="mb-3.5 flex max-md:justify-center">
            <div className="inline-flex gap-0.5 rounded-[12px] bg-[var(--fill-tertiary)] p-[3px] shadow-[inset_0_0_0_1px_var(--glass-edge)]" role="tablist">
              {([
                { id: "jobs", label: "Jobs", count: jobsQuery.isSuccess ? jobs.length : null },
                { id: "week", label: "Week", count: null },
              ] as { id: Lens; label: string; count: number | null }[]).map((it) => {
                const active = lens === it.id
                return (
                  <Button
                    key={it.id}
                    variant="ghost"
                    role="tab"
                    aria-selected={active}
                    data-testid={`cron-tab-${it.id}`}
                    onClick={() => setLens(it.id)}
                    className={`segment h-[34px] rounded-[9px] px-[15px] md:h-[34px] ${active ? "font-semibold" : ""}`}
                  >
                    {it.label}
                    {it.count != null && it.count > 0 && (
                      <span
                        className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[9px] px-1.5 text-[length:var(--text-caption2)] font-semibold tabular-nums"
                        style={
                          active
                            ? { background: "var(--fill-primary)", color: "var(--text-secondary)" }
                            : { background: "var(--fill-secondary)", color: "var(--text-tertiary)" }
                        }
                      >
                        {it.count}
                      </span>
                    )}
                  </Button>
                )
              })}
            </div>
          </div>

          <div key={lens} className="motion-safe:animate-[lensFade_120ms_var(--ease-smooth)]">
            {lens === "week" ? (
              <WeeklySchedule crons={jobs} />
            ) : jobsQuery.isLoading ? (
              <>
                <ListSkeleton />
                <ListSkeleton />
              </>
            ) : jobsQuery.isError ? (
              <div
                className="rounded-[var(--radius-lg)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
                style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
              >
                {jobsQuery.error instanceof Error ? jobsQuery.error.message : "Failed to load cron jobs"}
                <Button variant="link" size="sm" className="ml-3" onClick={() => void jobsQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : jobs.length === 0 ? (
              <div className="glass-card rounded-[var(--radius-xl)]" data-testid="cron-empty">
                <div className="px-6 py-12 text-center">
                  <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                    No cron jobs yet
                  </h3>
                  <p className="mx-auto mt-2 max-w-[320px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
                    Schedule one in chat — recurring work lands here the moment it's saved.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-3.5 flex gap-2" role="group" aria-label="Filter jobs">
                  {filters.map((f) => {
                    const active = filter === f.id
                    return (
                      <Button
                        key={f.id}
                        variant="ghost"
                        size="xs"
                        data-testid={`cron-filter-${f.id}`}
                        aria-pressed={active}
                        onClick={() => setFilter(f.id)}
                        className={`h-[28px] gap-[5px] px-[13px] md:h-[28px] ${
                          active
                            ? "font-semibold text-[var(--accent)] [--button-bg:var(--accent-fill)] [--button-bg-hover:var(--accent-fill)]"
                            : "text-[var(--text-secondary)] [--button-bg:var(--fill-tertiary)] [--button-bg-hover:var(--fill-secondary)]"
                        }`}
                      >
                        {f.label}
                        <span className="text-[length:var(--text-caption2)] tabular-nums opacity-75">{f.count}</span>
                      </Button>
                    )
                  })}
                </div>

                {shown.length === 0 ? (
                  <div className="px-6 py-14 text-center" data-testid="cron-no-match">
                    <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">No jobs match.</p>
                    <Button variant="link" className="mt-2" onClick={() => setFilter("all")}>
                      Clear filter
                    </Button>
                  </div>
                ) : (
                  groups.map((group) => (
                    <section key={group.employee ?? "_unassigned"} className="mb-[22px]">
                      <div className="flex items-center gap-2 px-1.5 pb-2">
                        {group.employee ? (
                          <EmployeeAvatar name={group.employee} size={20} fontSize={11} className="bg-[var(--fill-secondary)]" />
                        ) : (
                          <span className="grid size-5 flex-none place-items-center rounded-full bg-[var(--fill-tertiary)] text-[10px] text-[var(--text-quaternary)]" aria-hidden>
                            —
                          </span>
                        )}
                        <span className="text-[length:var(--text-footnote)] font-semibold tracking-[var(--tracking-tight)] text-[var(--text-secondary)]">
                          {displayNameOf(group.employee, byName)}
                        </span>
                        <span className="text-[length:var(--text-caption1)] tabular-nums text-[var(--text-quaternary)]">
                          {group.jobs.length}
                        </span>
                      </div>
                      <div className="glass-card rounded-[var(--radius-xl)] p-[5px]">
                        {group.jobs.map((job) => (
                          <CronRow key={job.id} job={job} now={now} onToggle={onToggle} onOpen={onOpen} />
                        ))}
                      </div>
                    </section>
                  ))
                )}
              </>
            )}
          </div>
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
