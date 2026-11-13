import type { EngineLimitAccountSnapshot, EngineLimitEngineSnapshot, EngineLimitsResponse } from "@/lib/api"
import { EngineCard } from "./engine-card"

interface CardItem {
  key: string
  engine: EngineLimitEngineSnapshot
  account?: EngineLimitAccountSnapshot
  title?: string
  /** Said instead of "No quota windows observed yet." when the card has no figures of its own. */
  emptyNote?: string
}

/** The engine card's line when every metered bucket belongs to an account's card. */
export const ALL_COVERED_NOTE = "Nothing metered outside the accounts."

/** The engine's own card when accounts exist: buckets of providers an account covers belong to that
 *  account's card, so only the rest (an `openrouter/*` bucket, say) stay here. */
function uncoveredEngine(engine: EngineLimitEngineSnapshot, accounts: EngineLimitAccountSnapshot[]): { engine: EngineLimitEngineSnapshot; emptyNote?: string } {
  if (!engine.buckets?.length) return { engine }
  const covered = new Set(accounts.flatMap((a) => (a.provider === undefined ? [] : [a.provider])))
  const buckets = engine.buckets.filter((b) => !covered.has(b.id.split("/")[0] ?? ""))
  if (buckets.length > 0) return { engine: { ...engine, buckets } }
  // Every metered bucket is an account's. The engine's top-level windows and plan are one of those buckets
  // (the most spent), so showing them here would repeat that account's spend under the engine's name.
  const { accountPlan: _plan, ...rest } = engine
  return { engine: { ...rest, buckets: [], windows: [] }, emptyNote: ALL_COVERED_NOTE }
}

/**
 * Every configured agent as one card in one grid: an engine on its own, or one
 * card per account (engine + profile) when the gateway reports accounts for it.
 * The gateway has already dropped the engines this instance does not use, so
 * this file only lays the cards out — no group headings, no nested sections.
 */
function cardsOf(data: EngineLimitsResponse | null): CardItem[] {
  const cards: CardItem[] = []
  for (const engine of Object.values(data?.engines ?? {})) {
    const accounts = data?.accounts?.[engine.name]
    if (!accounts?.length) {
      cards.push({ key: engine.name, engine })
      continue
    }
    // Claude's first account is the engine's own reading; opencode's accounts cover only the providers they name.
    if (engine.name === "opencode") cards.push({ key: engine.name, ...uncoveredEngine(engine, accounts) })
    for (const account of accounts) cards.push({ key: account.account, engine: account, account, title: account.label })
  }
  return cards
}

export function EngineCards({ data, now }: { data: EngineLimitsResponse | null; now: number }) {
  const cards = cardsOf(data)

  if (cards.length === 0) {
    return (
      <div className="glass-card rounded-[var(--radius-xl)] p-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        No configured engines to show.
      </div>
    )
  }

  return (
    <div className="grid auto-rows-fr items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="limits-grid">
      {cards.map(({ key, engine, account, title, emptyNote }) => (
        <EngineCard key={key} engine={engine} now={now} account={account} title={title} emptyNote={emptyNote} />
      ))}
    </div>
  )
}
