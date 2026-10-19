import type { EngineRegistryEntry } from "@/lib/api"
import { ChainBody, type ChainBodyProps } from "./chain-body"
import { classifyEngineHealth, type EngineHealthTone } from "./chain-model"
import { engineDisplayName } from "@/lib/engine-names"
import { ModelMapEditor } from "./model-map-editor"
import type { ModelMapPair, ServedModels } from "./model-map-model"
import { OpencodeFallbackNotice } from "./opencode-fallback-notice"

const TONE_COLOR: Record<EngineHealthTone, string> = {
  healthy: "var(--system-green)",
  exhausted: "var(--system-orange)",
  degraded: "var(--system-yellow)",
}

/** What the map editor needs of the chain it translates for. */
export interface ModelMapProps {
  /** Engines of the links the map applies to, in order; empty when none does. */
  substitutes: string[]
  /** Every link names a model, so the map has nothing to translate. */
  everyLinkNamesModel: boolean
  /** `[from, to]` model translations for turns that fall through this chain. */
  pairs: ModelMapPair[]
  /** Model ids per engine, so the map editor can constrain a target to what the
   *  stand-in actually serves rather than to anything that looks like an id. */
  served: ServedModels
  defaultModels: Record<string, string>
  onChange: (pairs: ModelMapPair[]) => void
}

/** Shown when the map can do something or has something to remove. A chain whose
 *  every link names a model translates nothing, so its map editor is out of the way. */
function showsModelMap(map: ModelMapProps): boolean {
  return map.pairs.length > 0 || !map.everyLinkNamesModel
}

/** One engine: what it is, whether it can serve a turn, and where its turns go
 *  when it cannot. A healthy engine states it quietly — six green sentences
 *  would drown the one card that is actually saying something. */
export function EngineCard({ entry, body, map }: {
  entry: EngineRegistryEntry
  body: ChainBodyProps
  map: ModelMapProps
}) {
  const health = classifyEngineHealth(entry.health)

  return (
    <div data-engine-card={entry.name} className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-3)]">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {engineDisplayName(entry.name)}
        </span>
        <span
          className="inline-flex shrink-0 items-center gap-[6px] text-[length:var(--text-caption1)] font-[var(--weight-medium)]"
          style={{ color: health.tone === "healthy" ? "var(--text-tertiary)" : TONE_COLOR[health.tone] }}
        >
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: TONE_COLOR[health.tone] }} />
          {health.label}
        </span>
      </div>
      <div className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        {entry.available ? "Installed" : "Not installed"} · {entry.defaultModel}
      </div>
      <OpencodeFallbackNotice entry={entry} />
      <ChainBody {...body} />
      {showsModelMap(map) && (
        <ModelMapEditor
          engine={entry.name}
          chain={map.substitutes}
          pairs={map.pairs}
          served={map.served}
          defaultModels={map.defaultModels}
          onChange={map.onChange}
        />
      )}
    </div>
  )
}

/** One declared Claude account: the chain its sessions follow, on the same rows an
 *  engine's chain has. It is its own card, named for the account. */
export function AccountCard({ name, body }: { name: string; body: ChainBodyProps }) {
  return (
    <div data-account-card={name} className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-3)]">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="min-w-0 truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {name}
        </span>
        <span className="shrink-0 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Claude account</span>
      </div>
      <ChainBody {...body} />
    </div>
  )
}
