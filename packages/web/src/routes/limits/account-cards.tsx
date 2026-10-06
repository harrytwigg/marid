import type { EngineLimitsResponse } from "@/lib/api"
import { EngineCard } from "./engine-card"

/**
 * The cards for every engine. With no `accounts` block this is the page as it
 * has always been: one card per engine in one grid. With it, an engine that has
 * several accounts becomes a headed group with a card per account, the default
 * first, and the engines with one account follow under their own heading.
 */
const HEADING = "text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]"

export function EngineCards({ data, now }: { data: EngineLimitsResponse | null; now: number }) {
  const engines = Object.values(data?.engines ?? {})
  const accounts = data?.accounts
  const grouped = engines.filter((engine) => accounts?.[engine.name]?.length)
  const single = engines.filter((engine) => !accounts?.[engine.name]?.length)
  // No accounts block: the page as it has always been, one card per engine in one grid.
  if (grouped.length === 0) {
    return (
      <div className="grid items-start gap-4 md:grid-cols-2">
        {single.map((engine) => <EngineCard key={engine.name} engine={engine} now={now} />)}
      </div>
    )
  }
  // With it, every engine sits under a heading, so a single-account engine never
  // reads as one more account of the group above it.
  return (
    <div className="grid gap-6">
      {grouped.map((engine) => (
        <section key={engine.name} data-testid="account-group" className="grid gap-4">
          <h2 className={`${HEADING} capitalize`}>{engine.name}</h2>
          <div className="grid items-start gap-4 md:grid-cols-2">
            {accounts![engine.name]!.map((account, index) => (
              <EngineCard key={account.account} engine={account} account={account} title={index === 0 ? account.name : account.label} now={now} />
            ))}
          </div>
        </section>
      ))}
      {single.length > 0 && (
        <section data-testid="other-engines" className="grid gap-4">
          <h2 className={HEADING}>Other engines</h2>
          <div className="grid items-start gap-4 md:grid-cols-2">
            {single.map((engine) => <EngineCard key={engine.name} engine={engine} now={now} nested />)}
          </div>
        </section>
      )}
    </div>
  )
}
