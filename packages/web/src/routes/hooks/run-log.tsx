import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { HOOK_RUN_STATUSES, type HookRun, type HookRunStatus } from "@/lib/api-hooks"
import { RunTable } from "./run-table"
import type { useHookRunParams } from "./use-hook-params"

/** The sentinel the two selects use for "no filter": a React Aria item's value
 *  must be a non-empty string, so the absent param is named rather than empty. */
const ALL = "all"

type HookRunParams = ReturnType<typeof useHookRunParams>

/** One of the log's two dropdown filters. The sentinel stands in for the
 *  absent param, which is what React Aria needs and what the URL means. */
function FilterSelect({
  label,
  ariaLabel,
  width,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string
  ariaLabel: string
  width: string
  placeholder: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</span>
      <Select value={value || ALL} onValueChange={(next) => onChange(next === ALL ? "" : next)}>
        <SelectTrigger aria-label={ariaLabel} className={width}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{placeholder}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function RunFilters({ params, hookNames }: { params: HookRunParams; hookNames: readonly string[] }) {
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Filter runs">
      <FilterSelect
        label="Hook"
        ariaLabel="Filter by hook"
        width="w-[180px]"
        placeholder="All hooks"
        value={params.hook}
        options={hookNames.map((name) => ({ value: name, label: name }))}
        onChange={params.setHook}
      />
      <FilterSelect
        label="Outcome"
        ariaLabel="Filter by outcome"
        width="w-[150px]"
        placeholder="Any outcome"
        value={params.outcome}
        options={HOOK_RUN_STATUSES.map((status) => ({ value: status, label: status }))}
        onChange={(value) => params.setOutcome(value as HookRunStatus | "")}
      />
      <label className="grid gap-1">
        <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Todo</span>
        <Input
          value={params.todo}
          onChange={(event) => params.setTodo(event.target.value)}
          placeholder="ABC-1"
          aria-label="Filter by Todo"
          className="w-[130px]"
        />
      </label>
    </div>
  )
}

function RunBody({ runs, loading, error, now }: { runs: readonly HookRun[]; loading: boolean; error: string | null; now: Date }) {
  if (loading) return <Skeleton height={200} className="rounded-[var(--radius-xl)]" data-testid="run-log-loading" />
  if (error) {
    return (
      <div role="alert" className="rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}>
        {error}
      </div>
    )
  }
  if (runs.length === 0) {
    return (
      <div data-testid="run-log-empty" className="glass-card rounded-[var(--radius-xl)] px-6 py-10 text-center text-[length:var(--text-subheadline)] text-[var(--text-tertiary)]">
        No runs yet.
      </div>
    )
  }
  return <RunTable runs={runs} now={now} />
}

/** The run log: newest first, paged by the `before` cursor, one row per action
 *  of a firing. A row opens onto its payload and output. */
export function RunLog({
  runs,
  hookNames,
  params,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  now,
}: {
  runs: readonly HookRun[]
  hookNames: readonly string[]
  params: HookRunParams
  loading: boolean
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  now: Date
}) {
  return (
    <section className="grid gap-[var(--space-4)]" data-testid="run-log">
      <RunFilters params={params} hookNames={hookNames} />
      <RunBody runs={runs} loading={loading} error={error} now={now} />
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </section>
  )
}
