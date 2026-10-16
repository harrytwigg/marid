import { useEffect, useRef, useState } from 'react'
import { ArrowRightLeftIcon, CheckIcon, ChevronRightIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { FallbackTargetPicker } from './fallback-target-picker'
import { api } from '@/lib/api'
import {
  FALLBACK_MODE_OPTIONS,
  fallbackChipText,
  parseFallbackView,
  fallbackChipTitle,
  withMode,
  withTarget,
  hasOwnTarget,
  type FallbackTargetChoice,
  type SessionFallbackMode,
  type SessionFallbackView,
} from './fallback-mode-model'

interface FallbackModeChipProps {
  sessionId: string
  /** `session.fallback` from GET /api/sessions/:id; absent on an older gateway. */
  view: SessionFallbackView | null | undefined
  disabled?: boolean
  /** Gateway event subscription; a `session:updated` for this session re-reads its fallback view. */
  subscribe?: FallbackSubscribe
}

type FallbackSubscribe = (fn: GatewayEventListener) => () => void

/** Re-read the view when the gateway says this session changed, dropping a read that lands after a session switch. */
function useFallbackResync(
  sessionId: string,
  subscribe: FallbackSubscribe | undefined,
  gen: { current: number },
  accept: (next: SessionFallbackView | null) => void,
) {
  useEffect(() => {
    if (!subscribe) return
    return subscribe((frame) => {
      if (frame.event !== 'session:updated' || frame.payload.sessionId !== sessionId) return
      const mine = gen.current
      api.getSession(sessionId, { messages: false })
        .then((s) => { if (gen.current === mine) accept(parseFallbackView(s.fallback)) })
        .catch(() => {})
    })
    // `accept` only touches refs and a state setter, so a stale copy behaves the same.
  }, [subscribe, sessionId])
}

/**
 * Optimistic mode change with rollback to the last server-confirmed view. A
 * fresh server view replaces the local copy unless a PUT is in flight, and a
 * session switch discards any result still on its way for the old session.
 */
function useFallbackMode(sessionId: string, view: SessionFallbackView | null | undefined, subscribe?: FallbackSubscribe) {
  const [local, setLocal] = useState<SessionFallbackView | null | undefined>(view)
  const [error, setError] = useState<string | null>(null)
  // `gen` changes with the session, so nothing still on its way for the old one lands;
  // `seq` orders picks within a session, so only the newest pick moves the chip.
  const gen = useRef(0)
  const seq = useRef(0)
  const inFlight = useRef(0)
  const confirmed = useRef(view)
  const viewKey = JSON.stringify(view ?? null)

  const accept = (next: SessionFallbackView | null | undefined) => {
    confirmed.current = next
    if (inFlight.current === 0) setLocal(next)
  }
  useEffect(() => { gen.current++; inFlight.current = 0; confirmed.current = view; setLocal(view); setError(null) }, [sessionId])
  useEffect(() => { accept(view); if (inFlight.current === 0) setError(null) }, [viewKey])
  useFallbackResync(sessionId, subscribe, gen, accept)

  /** Send one change and show it at once; `optimistic` is the view if the server accepts it.
   *  Resolves true when the server took it, false when it refused (the error is on the chip). */
  const change = (body: { fallbackMode?: SessionFallbackMode; fallbackTarget?: FallbackTargetChoice | null }, optimistic: (view: SessionFallbackView) => SessionFallbackView): Promise<boolean> => {
    if (!local) return Promise.resolve(false)
    const session = gen.current
    const mine = ++seq.current
    inFlight.current++
    setLocal(optimistic(local))
    setError(null)
    return api.updateSession(sessionId, body)
      .then((res) => {
        if (gen.current !== session) return true
        // What the server now holds, even when a newer pick has taken over the chip:
        // a later failure rolls back to it, not to the view before this pick.
        const next = parseFallbackView(res?.fallback) ?? optimistic(confirmed.current ?? local)
        confirmed.current = next
        if (seq.current === mine) setLocal(next)
        return true
      })
      .catch((err) => {
        if (gen.current !== session || seq.current !== mine) return false
        setLocal(confirmed.current ?? local)
        setError(err instanceof Error ? err.message : 'Fallback update failed')
        return false
      })
      .finally(() => { if (gen.current === session && --inFlight.current < 0) inFlight.current = 0 })
  }
  const pick = (value: string) => {
    const mode = value as SessionFallbackMode
    if (!local || mode === local.mode) return
    void change({ fallbackMode: mode }, (view) => withMode(view, mode))
  }
  const pickTarget = (choice: FallbackTargetChoice | null) => change({ fallbackTarget: choice }, (view) => withTarget(view, choice))
  return { local, error, pick, pickTarget }
}

function FallbackModeMenu({ local, error, onPick, onChooseModel, onUseConfig }: {
  local: SessionFallbackView
  error: string | null
  onPick: (mode: string) => void
  onChooseModel: () => void
  onUseConfig: () => void
}) {
  return (
    <>
      <div className="px-2 pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
        When the usage limit is hit
      </div>
      <DropdownMenuRadioGroup value={local.mode} onValueChange={onPick} aria-label="Fallback mode">
        {FALLBACK_MODE_OPTIONS.map((o) => (
          <DropdownMenuRadioItem
            key={o.mode}
            value={o.mode}
            onSelect={(e) => e.preventDefault()}
            className="items-start justify-between gap-2 rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[state=checked]:text-[var(--text-primary)] [&>span:first-child]:hidden"
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
      {!local.target && (
        <div className="px-2 pt-1 pb-0.5 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
          No fallback configured for this model
        </div>
      )}
      {error && (
        <div role="alert" className="px-2 pt-1 pb-0.5 text-[length:var(--text-caption2)] text-[var(--system-red)]">
          {error}
        </div>
      )}
    </>
  )
}

/**
 * Chip beside the model selector showing what happens when the session hits a
 * usage limit, with a three-option menu to change it. Renders nothing when the
 * gateway sends no `fallback` view.
 */
export function FallbackModeChip({ sessionId, view, disabled, subscribe }: FallbackModeChipProps) {
  const { local, error, pick, pickTarget } = useFallbackMode(sessionId, view, subscribe)
  // The menu is the mode list, or the model picker the "Choose fallback model…" row opens in its place.
  const [open, setOpen] = useState(false)
  const [panel, setPanel] = useState<'mode' | 'pick'>('mode')
  // A target change closes the menu once the server has taken it; a refusal goes back to the list, which shows why.
  const applyTarget = (choice: FallbackTargetChoice | null) => {
    void pickTarget(choice).then((ok) => { if (ok) setOpen(false); else setPanel('mode') })
  }
  if (!local) return null
  const text = fallbackChipText(local)

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) setPanel('mode') }}>
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
            {text}
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
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        {panel === 'pick' ? (
          <FallbackTargetPicker
            view={local}
            onBack={() => setPanel('mode')}
            onChoose={applyTarget}
          />
        ) : (
          <FallbackModeMenu
            local={local}
            error={error}
            onPick={pick}
            onChooseModel={() => setPanel('pick')}
            onUseConfig={() => applyTarget(null)}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
