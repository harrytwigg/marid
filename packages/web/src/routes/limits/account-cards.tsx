import type { EngineLimitsResponse } from "@/lib/api"
import { EngineCard } from "./engine-card"

/**
 * The cards for every engine. With no `accounts` block this is the page as it
 * has always been: one card per engine in one grid. With it, an engine that has
 * several accounts becomes a headed group with a card per account, the default
 * first; an engine with one account stays a single card.
 */
export function EngineCards({ data, now }: { data: EngineLimitsResponse | null; now: number }) {
  const engines = Object.values(data?.engines ?? {})
  const accounts = data?.accounts
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      {engines.map((engine) => {
        const group = accounts?.[engine.name]
        if (!group?.length) return <EngineCard key={engine.name} engine={engine} now={now} />
        return (
          <div key={engine.name} data-testid="account-group" className="grid gap-4 md:col-span-2">
            <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)] capitalize">
              {engine.name}
            </h2>
            <div className="grid items-start gap-4 md:grid-cols-2">
              {group.map((account, index) => (
                <EngineCard
                  key={account.account}
                  engine={account}
                  account={account}
                  title={index === 0 ? account.name : account.label}
                  now={now}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
