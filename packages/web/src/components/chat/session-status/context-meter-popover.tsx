import { Popover } from 'radix-ui'
import { LoaderCircleIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ContextUsageWire } from '@/lib/api-context-usage'
import { fmtK, formatContextUsage, type ContextUsage } from '@/lib/context-usage'
import { compactDisabledReason, enabledBudget } from './context-meter-model'
import type { CompactPhase } from './use-compact-flow'

interface ContextMeterPopoverProps {
  trigger: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  data: ContextUsageWire
  tokens: number | null
  loading: boolean
  phase: CompactPhase
  onCompact: () => void
}

const LABEL = 'text-[var(--text-tertiary)]'
const VALUE = 'font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-secondary)]'

function UsageBar({ usage }: { usage: ContextUsage }) {
  return (
    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
      <div
        className="h-full rounded-full"
        style={{ width: `${Math.max(usage.pct * 100, 2)}%`, background: usage.color ?? 'var(--accent)' }}
      />
    </div>
  )
}

function usageText(usage: ContextUsage | null, tokens: number | null): string {
  if (usage) return usage.label
  return tokens != null ? `${fmtK(tokens)} used` : 'n/a'
}

function UsageRows({ data, tokens }: { data: ContextUsageWire; tokens: number | null }) {
  const budget = enabledBudget(data)
  const usage = tokens == null ? null : formatContextUsage(tokens, data.contextWindow, budget)
  return (
    <>
      <div className="flex items-center justify-between">
        <span className={LABEL}>Context</span>
        <span className={VALUE} style={usage?.color ? { color: usage.color } : undefined} data-testid="context-meter-usage">
          {usageText(usage, tokens)}
        </span>
      </div>
      {usage && <UsageBar usage={usage} />}
      <div className="mt-2 flex items-center justify-between">
        <span className={LABEL}>Model</span>
        <span className="truncate pl-3 text-[var(--text-secondary)]">{data.modelLabel ?? data.model ?? data.engine}</span>
      </div>
      {data.autoCompact.enabled && (
        <div className="mt-1 flex items-center justify-between">
          <span className={LABEL}>Auto-compact</span>
          <span className={VALUE}>{budget ? `at ${fmtK(budget)}` : 'on'}</span>
        </div>
      )}
    </>
  )
}

/** The meter's popover: the figures, and the one manual action. */
export function ContextMeterPopover({ trigger, open, onOpenChange, data, tokens, loading, phase, onCompact }: ContextMeterPopoverProps) {
  const compacting = phase.kind === 'compacting'
  const reason = compactDisabledReason(data, loading)
  const disabled = compacting || reason != null
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          // Keep a margin from the viewport edge: at 375px the left-aligned popover
          // would otherwise be shifted flush against the right edge.
          collisionPadding={8}
          aria-label="Context usage"
          className="z-50 w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-3 text-[length:var(--text-caption1)] shadow-[var(--shadow-overlay)] motion-safe:data-[state=closed]:animate-pop-out motion-safe:data-[state=open]:animate-pop-in"
        >
          <UsageRows data={data} tokens={tokens} />
          <button
            type="button"
            disabled={disabled}
            onClick={onCompact}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-[8px] bg-[var(--accent-fill)] px-2 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:bg-[var(--fill-tertiary)] disabled:text-[var(--text-quaternary)]"
          >
            {compacting ? (
              <>
                <LoaderCircleIcon aria-hidden className="size-3.5 motion-safe:animate-spin" />
                Compacting…
              </>
            ) : (
              'Compact now'
            )}
          </button>
          {!compacting && reason && phase.kind !== 'error' && (
            <p data-testid="compact-reason" className="mt-1.5 text-[length:var(--text-caption2)] leading-snug text-[var(--text-tertiary)]">{reason}</p>
          )}
          {phase.kind === 'done' && (
            <p role="status" data-testid="compact-outcome" className="mt-1.5 text-[length:var(--text-caption2)] leading-snug text-[var(--text-secondary)]">{phase.message}</p>
          )}
          {phase.kind === 'error' && (
            <p role="alert" data-testid="compact-error" className="mt-1.5 text-[length:var(--text-caption2)] leading-snug text-[var(--system-red)]">{phase.message}</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
