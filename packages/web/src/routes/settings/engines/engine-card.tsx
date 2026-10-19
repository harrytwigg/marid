import type { EngineRegistryEntry } from "@/lib/api"
import { ChainEditor } from "./chain-editor"
import { addOptionsFor, classifyEngineHealth, type EngineHealthTone } from "./chain-model"
import { engineDisplayName } from "@/lib/engine-names"
import { ModelMapEditor } from "./model-map-editor"
import type { ModelMapPair, ServedModels } from "./model-map-model"

const TONE_COLOR: Record<EngineHealthTone, string> = {
  healthy: "var(--system-green)",
  exhausted: "var(--system-orange)",
  degraded: "var(--system-yellow)",
}

/** One engine: what it is, whether it can serve a turn, and where its turns go
 *  when it cannot. A healthy engine states it quietly — six green sentences
 *  would drown the one card that is actually saying something. */
export function EngineCard({ entry, chain, modelMap, registryEngines, served, defaultModels, onChange, onMapChange }: {
  entry: EngineRegistryEntry
  chain: string[]
  /** `[from, to]` model translations for turns that fall through this chain. */
  modelMap: ModelMapPair[]
  registryEngines: string[]
  /** Model ids per engine, so the map editor can constrain a target to what the
   *  stand-in actually serves rather than to anything that looks like an id. */
  served: ServedModels
  defaultModels: Record<string, string>
  onChange: (chain: string[]) => void
  onMapChange: (pairs: ModelMapPair[]) => void
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
      <ChainEditor
        engine={entry.name}
        chain={chain}
        options={addOptionsFor(registryEngines, entry.name, chain)}
        onChange={onChange}
      />
      <ModelMapEditor
        engine={entry.name}
        chain={chain}
        pairs={modelMap}
        served={served}
        defaultModels={defaultModels}
        onChange={onMapChange}
      />
    </div>
  )
}
