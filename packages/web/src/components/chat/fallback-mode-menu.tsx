import { CheckIcon, ChevronRightIcon } from '@/components/ui/icon'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { FALLBACK_MODE_OPTIONS, hasOwnTarget, servedByLabel, type SessionFallbackView } from './fallback-mode-model'

/** The three modes, as a radio list; the session's current one is checked. */
function ModeOptions({ local, onPick }: { local: SessionFallbackView; onPick: (mode: string) => void }) {
  return (
    <DropdownMenuRadioGroup value={local.mode} onValueChange={onPick} aria-label="Fallback mode">
      {FALLBACK_MODE_OPTIONS.map((o) => (
        <DropdownMenuRadioItem
          key={o.mode}
          value={o.mode}
          onSelect={(e) => e.preventDefault()}
          className="items-start justify-between gap-2 rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[selected]:text-[var(--text-primary)] [&>span:first-child]:hidden"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-[var(--weight-semibold)]">
              {o.title}
              {o.mode === local.mode && local.modeSource === 'default' && (
                <span className="ml-1 font-normal text-[var(--text-quaternary)]">(default)</span>
              )}
            </span>
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{o.description}</span>
          </span>
          {o.mode === local.mode && <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-[var(--accent)]" />}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

/** Choose the session's own fallback model, or hand the choice back to the config's chain. */
function TargetRows({ local, onChooseModel, onUseConfig }: { local: SessionFallbackView; onChooseModel: () => void; onUseConfig: () => void }) {
  return (
    <>
      <DropdownMenuSeparator className="bg-[var(--separator)]" />
      <DropdownMenuItem
        onSelect={(e) => { e.preventDefault(); onChooseModel() }}
        className="gap-2 rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
      >
        <span className="flex-1">Choose fallback model…</span>
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
      </DropdownMenuItem>
      {hasOwnTarget(local) && (
        <DropdownMenuItem
          onSelect={(e) => { e.preventDefault(); onUseConfig() }}
          className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
        >
          Use config fallback
        </DropdownMenuItem>
      )}
    </>
  )
}

export function FallbackModeMenu({ local, error, onPick, onChooseModel, onUseConfig }: {
  local: SessionFallbackView
  error: string | null
  onPick: (mode: string) => void
  onChooseModel: () => void
  onUseConfig: () => void
}) {
  return (
    <>
      <DropdownMenuLabel className="pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        When the usage limit is hit
      </DropdownMenuLabel>
      <ModeOptions local={local} onPick={onPick} />
      <TargetRows local={local} onChooseModel={onChooseModel} onUseConfig={onUseConfig} />
      {!local.target && (
        <DropdownMenuLabel className="pt-1 pb-0.5 text-[length:var(--text-caption2)] font-normal text-[var(--text-quaternary)]">
          No fallback configured for this model
        </DropdownMenuLabel>
      )}
      {servedByLabel(local) && (
        <DropdownMenuLabel data-testid="fallback-served-by" className="pt-1 pb-0.5 text-[length:var(--text-caption2)] font-normal text-[var(--text-tertiary)]">
          Served by {servedByLabel(local)}
        </DropdownMenuLabel>
      )}
      {error && (
        <DropdownMenuLabel className="pt-1 pb-0.5 text-[length:var(--text-caption2)] font-normal text-[var(--system-red)]">
          <div role="alert">{error}</div>
        </DropdownMenuLabel>
      )}
    </>
  )
}
