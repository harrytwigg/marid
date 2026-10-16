import { useState } from 'react'
import { contextMeterModel } from './context-meter-model'
import { ContextMeterPopover } from './context-meter-popover'
import { ContextMeterRing } from './context-meter-ring'
import { useCompactFlow } from './use-compact-flow'

export interface ContextMeterProps {
  sessionId: string
  /** The pane's turn flag: a running turn blocks a manual compact. */
  loading: boolean
  status?: string | null
  lastContextTokens?: number | null
  /** The streaming figure, overlaid on the fetched one while a turn runs and until its refetch lands. */
  liveContextTokens?: number | null
}

/**
 * The composer's context meter: a ring and a percentage that turn amber and red
 * as the window fills, and a popover with the figures and "Compact now".
 */
export function ContextMeter({ sessionId, loading, status, lastContextTokens, liveContextTokens }: ContextMeterProps) {
  const [open, setOpen] = useState(false)
  // The streamed figure belongs to a running turn; the flow keeps it only until the
  // post-turn refetch lands, so the fetched size wins after a compaction.
  const { data, phase, start, dismiss, shown, live } = useCompactFlow({ sessionId, loading, status, lastContextTokens, liveContextTokens })
  const model = contextMeterModel(data, live)
  if (model.kind === 'hidden' || !data) return null

  const known = model.kind === 'known'
  return (
    <ContextMeterPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) dismiss()
      }}
      data={data}
      tokens={shown}
      loading={loading}
      phase={phase}
      onCompact={() => { void start() }}
      trigger={
        <button
          type="button"
          title={model.tooltip}
          aria-label={`Context usage: ${model.tooltip}`}
          data-testid="context-meter"
          data-compacting={phase.kind === 'compacting' || undefined}
          className="inline-flex min-h-[40px] md:min-h-0 items-center gap-1.5 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-caption1)] transition-colors hover:bg-[var(--fill-secondary)] cursor-pointer"
        >
          <ContextMeterRing
            fraction={known ? model.usage.pct : null}
            color={known ? model.usage.color : undefined}
            pulsing={phase.kind === 'compacting'}
          />
          {/* Dropped on a narrow composer; the ring stays. Measured against the composer container, like the model chip's effort label. */}
          <span
            data-testid="context-meter-text"
            className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-tertiary)] @max-[380px]/composer:hidden"
            style={known && model.usage.color ? { color: model.usage.color } : undefined}
          >
            {known ? model.percent : 'n/a'}
          </span>
        </button>
      }
    />
  )
}
