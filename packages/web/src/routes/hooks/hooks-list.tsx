import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import type { BoardHook, HookRunStatus } from "@/lib/api-hooks"
import { agoLabel } from "@/lib/cron-utils"
import { actionsSummary, eventsSummary, matchSummary, outcomeBadgeVariant } from "./format"
import { useHookToggle } from "./use-hooks"

/** The configured hooks, one row each: what it watches, what it does, when it
 *  last fired, and the one control the page owns — the enabled switch. Hooks
 *  themselves are `config.yaml`; this page reads and toggles, never edits. */

function LastStatus({ status }: { status: HookRunStatus }) {
  return <Badge variant={outcomeBadgeVariant(status)}>{status}</Badge>
}

function HookRow({ hook, now }: { hook: BoardHook; now: Date }) {
  const { error, onCheckedChange } = useHookToggle(hook)
  const fired = hook.lastFiredAt ? `fired ${agoLabel(hook.lastFiredAt, now)}` : "never fired"

  return (
    <div
      data-testid={`hook-row-${hook.name}`}
      className="flex flex-wrap items-start gap-3 border-t-[0.5px] border-[var(--separator)] px-3.5 py-3 first:border-t-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[length:var(--text-subheadline)] font-medium text-[var(--text-primary)]">
            {hook.name}
          </span>
          {hook.lastStatus && <LastStatus status={hook.lastStatus} />}
        </div>
        <p className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {eventsSummary(hook.events)} · {matchSummary(hook.match)}
        </p>
        <p className="mt-0.5 break-words text-[length:var(--text-caption1)] text-[var(--text-quaternary)]" style={{ fontFamily: "var(--font-code)" }}>
          {actionsSummary(hook)}
        </p>
        <p className="mt-0.5 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">{fired}</p>
        {error && (
          <p role="alert" className="mt-1 text-[length:var(--text-caption1)] text-[var(--system-red)]">
            {error}
          </p>
        )}
      </div>
      <Switch
        checked={hook.enabled}
        onCheckedChange={onCheckedChange}
        aria-label={hook.enabled ? `Disable ${hook.name}` : `Enable ${hook.name}`}
      />
    </div>
  )
}

function Problems({ problems }: { problems: readonly string[] }) {
  return (
    <div
      data-testid="hooks-problems"
      className="rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-orange)]"
      style={{ background: "color-mix(in srgb, var(--system-orange) 10%, transparent)" }}
    >
      <p className="font-[var(--weight-semibold)]">Some hooks are misconfigured and were skipped:</p>
      <ul className="mt-1 list-disc pl-4">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  )
}

function Empty() {
  return (
    <div data-testid="hooks-empty" className="glass-card rounded-[var(--radius-xl)] px-6 py-12 text-center">
      <h3 className="text-[length:var(--text-title3)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
        No hooks configured
      </h3>
      <p className="mx-auto mt-2 max-w-[420px] text-[length:var(--text-subheadline)] leading-relaxed text-[var(--text-tertiary)]">
        Add a <code>hooks:</code> block to config.yaml. The shape is written up in docs/board-hooks.md.
      </p>
    </div>
  )
}

export function HooksList({
  hooks,
  problems,
  loading,
  error,
  now,
}: {
  hooks: readonly BoardHook[]
  problems: readonly string[]
  loading: boolean
  /** The read's failure, when there was one. The page shows it above; here it
   *  only suppresses states that would otherwise claim the config is empty. */
  error: string | null
  now: Date
}) {
  if (loading) return <Skeleton height={180} className="rounded-[var(--radius-xl)]" data-testid="hooks-loading" />
  // A failed read is not an empty config: the alert above says so, and the
  // "no hooks configured" line would be a lie about a config we never read.
  if (error) return null
  return (
    <div className="grid gap-[var(--space-4)]">
      {problems.length > 0 && <Problems problems={problems} />}
      {hooks.length === 0 ? (
        <Empty />
      ) : (
        <div className="glass-card overflow-hidden rounded-[var(--radius-xl)] p-[5px]">
          {hooks.map((hook) => (
            <HookRow key={hook.name} hook={hook} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
