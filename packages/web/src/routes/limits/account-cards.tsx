import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"
import { EngineCard } from "./engine-card"

interface CardItem {
  key: string
  engine: EngineLimitEngineSnapshot
  account?: EngineLimitAccountSnapshot
  title?: string
}

/**
 * Every configured agent as one card in one grid: an engine on its own, or one
 * card per account (engine + profile) when the gateway reports accounts for it.
 * The gateway has already dropped the engines this instance does not use, so
 * this file only lays the cards out — no group headings, no nested sections.
 */
export function EngineCards({ data, now }: { data: EngineLimitsResponse | null; now: number }) {
  const cards: CardItem[] = []
  for (const engine of Object.values(data?.engines ?? {})) {
    const accounts = data?.accounts?.[engine.name]
    if (accounts?.length) {
      for (const account of accounts) cards.push({ key: account.account, engine: account, account, title: account.label })
    } else {
      cards.push({ key: engine.name, engine })
    }
  }

  if (cards.length === 0) {
    return (
      <div className="glass-card rounded-[var(--radius-xl)] p-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        No configured engines to show.
      </div>
    )
  }

  return (
    <div className="grid auto-rows-fr items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="limits-grid">
      {cards.map(({ key, engine, account, title }) => (
        <EngineCard key={key} engine={engine} now={now} account={account} title={title} />
      ))}
    </div>
  )
}
