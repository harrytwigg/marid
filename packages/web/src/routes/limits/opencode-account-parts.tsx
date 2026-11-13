import { AlertTriangle } from "@/components/ui/icon"
import type { EngineLimitAccountSnapshot, EngineLimitBucket, EngineLimitWindow } from "@/lib/api"
import { agoLabel, barColor, clampPercent, resetLabel, windowLabel } from "./format"

/** An opencode account: the gateway sends its provider id with the snapshot. */
export function isOpencodeAccount(account: EngineLimitAccountSnapshot | undefined): account is EngineLimitAccountSnapshot & { provider: string } {
  return account?.provider !== undefined
}

function bucketWindows(bucket: EngineLimitBucket): EngineLimitWindow[] {
  if (bucket.windows?.length) return bucket.windows
  return [bucket.primary, bucket.secondary].filter((w): w is EngineLimitWindow => w !== undefined)
}

/** The model of a bucket id `<provider>/<model>`; with no provider (the engine's own card) the id is shown whole. */
function modelOf(bucket: EngineLimitBucket, provider: string | undefined): string {
  if (provider === undefined) return bucket.id
  const model = bucket.id.startsWith(`${provider}/`) ? bucket.id.slice(provider.length + 1) : bucket.name ?? bucket.id
  return model === "*" ? "All models" : model
}

function WindowRow({ window, now }: { window: EngineLimitWindow; now: number }) {
  const observed = window.usedPercent !== undefined
  const reset = resetLabel(window.resetsAtIso, now)
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-[var(--space-3)] text-[length:var(--text-caption1)]">
        <span className="text-[var(--text-secondary)]">{windowLabel(window)}</span>
        <span className="font-[var(--weight-semibold)] text-[var(--text-primary)] tabular-nums">
          {observed ? `${window.usedPercent}%` : "—"}
        </span>
      </div>
      <div className="mt-[2px] h-1.5 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
        {observed && (
          <div className="h-full rounded-full" style={{ width: `${clampPercent(window.usedPercent)}%`, background: barColor(window.usedPercent) }} />
        )}
      </div>
      {reset && <div className="mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{reset}</div>}
    </div>
  )
}

/** One block per metered model, each with its 5h/7d/30d window rows. */
export function ModelBuckets({ buckets: all, provider, empty = "No usage limits set on this account.", now }: {
  buckets: EngineLimitBucket[] | undefined
  provider?: string
  empty?: string
  now: number
}) {
  const buckets = (all ?? []).filter((b) => bucketWindows(b).length > 0)
  if (buckets.length === 0) {
    return (
      <div className="mt-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        {empty}
      </div>
    )
  }
  return (
    <div className="mt-[var(--space-6)] grid gap-[var(--space-5)]" data-testid="model-buckets">
      {buckets.map((bucket) => (
        <section key={bucket.id} data-bucket={bucket.id} className="min-w-0">
          <h3 className="truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
            {modelOf(bucket, provider)}
          </h3>
          <div className="mt-[var(--space-2)] grid gap-[var(--space-3)]">
            {bucketWindows(bucket).map((w) => <WindowRow key={`${bucket.id}-${w.name}`} window={w} now={now} />)}
          </div>
        </section>
      ))}
    </div>
  )
}

const FAILURE_LABEL = { quota: "quota", auth: "authentication", "model-access": "model access" } as const

function keyLine(account: EngineLimitAccountSnapshot): string | null {
  if (account.base === undefined) return null
  if (account.keySet === undefined) return `Key: ${account.keyEnv}`
  return `Key: ${account.keyEnv} ${account.keySet ? "is set" : "is not set"}`
}

function nextTryLine(account: EngineLimitAccountSnapshot, now: number): string | null {
  if (!account.nextTryAt || account.exhausted) return null
  if (new Date(account.nextTryAt).getTime() <= now) return "Next try now"
  const when = resetLabel(account.nextTryAt, now)?.replace(/^resets /, "")
  return when ? `Next try ${when}` : null
}

function failureLine(account: EngineLimitAccountSnapshot, now: number): string | null {
  const failure = account.lastFailure
  return failure ? `Last failure: ${FAILURE_LABEL[failure.class]}, ${agoLabel(failure.at, now)}` : null
}

function Fact({ id, text, warn }: { id: string; text: string | null; warn?: boolean }) {
  if (!text) return null
  return <div data-testid={id} style={warn ? { color: "var(--system-orange)" } : undefined}>{text}</div>
}

/** What the account is held for and when it is tried again, from the facts it carries. */
export function AccountFacts({ account, now }: { account: EngineLimitAccountSnapshot & { provider: string }; now: number }) {
  return (
    <div className="mt-[var(--space-5)] grid gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]" data-testid="account-facts">
      <div className="truncate text-[var(--text-tertiary)]">
        {account.provider}{account.base ? ` · from ${account.base}` : " · built-in"}
      </div>
      <Fact id="key-state" text={keyLine(account)} warn={account.keySet === false} />
      <Fact id="next-try" text={nextTryLine(account, now)} />
      <Fact id="last-failure" text={failureLine(account, now)} />
      {account.problems?.map((problem, i) => (
        <div key={`${i}-${problem}`} className="flex items-start gap-[var(--space-2)]" data-testid="account-problem">
          <AlertTriangle size={14} className="mt-[2px] flex-shrink-0" style={{ color: "var(--system-orange)" }} />
          <span>{problem}</span>
        </div>
      ))}
    </div>
  )
}
