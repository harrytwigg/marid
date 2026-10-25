import { useState } from 'react'
import { ArrowRightLeftIcon } from '@/components/ui/icon'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { FallbackTargetPicker } from './fallback-target-picker'
import { FallbackModeMenu } from './fallback-mode-menu'
import { useFallbackMode, type FallbackSave, type FallbackSubscribe } from './use-fallback-view'
import {
  fallbackChipText,
  fallbackChipTitle,
  type FallbackTargetChoice,
  type SessionFallbackView,
} from './fallback-mode-model'

interface FallbackModeChipProps {
  sessionId: string
  /** `session.fallback` from GET /api/sessions/:id; absent on an older gateway. */
  view: SessionFallbackView | null | undefined
  disabled?: boolean
  /** Gateway event subscription; a `session:updated` for this session re-reads its fallback view. */
  subscribe?: FallbackSubscribe
  /** Takes a change instead of the session's PUT: the new-chat screen, where no session exists yet. */
  save?: FallbackSave
}

/** The chip's button: what happens at a usage limit, in one truncating line. */
function ChipButton({ local, disabled }: { local: SessionFallbackView; disabled?: boolean }) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      {/* shrink-[100] against the model button's 1: the chip gives up its text first, and
          once it is down to its icon the model label takes the rest. Keep both factors >= 1:
          when the unfrozen items' factors sum below 1, flex absorbs only that fraction of the
          overflow and the wrapper clips the chip instead. */}
      <button
        type="button"
        data-testid="fallback-mode-chip"
        disabled={disabled}
        title={fallbackChipTitle(local)}
        aria-label={`${fallbackChipTitle(local)}. Change fallback mode`}
        className="group inline-flex min-h-[40px] md:min-h-0 min-w-[28px] shrink-[100] items-center gap-1 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
      >
        <ArrowRightLeftIcon aria-hidden className="size-3 shrink-0 text-[var(--text-tertiary)]" />
        {/* One truncating span, so the children marker clips with the text (never on its own) and hides with it. */}
        <span className="min-w-0 truncate text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)] transition-colors @max-[480px]/composer:hidden">
          {fallbackChipText(local)}
          {local.mode === 'fallback-children' && (
            <span
              data-testid="fallback-children-marker"
              title="Child sessions inherit this fallback"
              className="ml-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]"
            >
              + children
            </span>
          )}
        </span>
      </button>
    </DropdownMenuTrigger>
  )
}

/**
 * Chip beside the model selector showing what happens when the session hits a
 * usage limit, with a menu to change the mode and to choose the model it falls
 * back to. Renders nothing when the gateway sends no `fallback` view.
 */
export function FallbackModeChip({ sessionId, view, disabled, subscribe, save }: FallbackModeChipProps) {
  const { local, error, pick, pickTarget } = useFallbackMode(sessionId, view, subscribe, save)
  // The menu is the mode list, or the model picker the "Choose fallback model…" row opens in its place.
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<'mode' | 'pick'>('mode')
  // A target change closes the menu once the server has taken it; a refusal goes back to the list, which shows why.
  const applyTarget = (choice: FallbackTargetChoice | null) => {
    void pickTarget(choice).then((ok) => { if (ok) setOpen(false); else setPanel('mode') })
  }
  if (!local) return null

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setPanel('mode') }}>
      <ChipButton local={local} disabled={disabled} />
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="w-72 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] p-1.5"
      >
        {panel === 'pick' ? (
          <FallbackTargetPicker view={local} onBack={() => setPanel('mode')} onChoose={applyTarget} />
        ) : (
          <FallbackModeMenu local={local} error={error} onPick={pick} onChooseModel={() => setPanel('pick')} onUseConfig={() => applyTarget(null)} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
