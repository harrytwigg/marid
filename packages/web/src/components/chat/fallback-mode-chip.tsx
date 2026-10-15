import { useEffect, useRef, useState } from 'react'
import { ArrowRightLeftIcon, CheckIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import type { GatewayEventListener } from '@jinn/gateway-events'
import { api } from '@/lib/api'
import {
  FALLBACK_MODE_OPTIONS,
  fallbackChipText,
  parseFallbackView,
  fallbackChipTitle,
  withMode,
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

/**
 * Optimistic mode change with rollback to the last server-confirmed view. A
 * fresh server view replaces the local copy unless a PUT is in flight, and a
 * session switch discards any result still on its way for the old session.
 */
function useFallbackMode(sessionId: string, view: SessionFallbackView | null | undefined, subscribe?: FallbackSubscribe) {
  const [local, setLocal] = useState<SessionFallbackView | null | undefined>(view)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const inFlight = useRef(0)
  const confirmed = useRef(view)
  const viewKey = JSON.stringify(view ?? null)

  const accept = (next: SessionFallbackView | null | undefined) => {
    confirmed.current = next
    if (inFlight.current === 0) setLocal(next)
  }
  useEffect(() => { seq.current++; inFlight.current = 0; confirmed.current = view; setLocal(view); setError(null) }, [sessionId])
  useEffect(() => { accept(view); if (inFlight.current === 0) setError(null) }, [viewKey])
  useEffect(() => {
    if (!subscribe) return
    return subscribe((frame) => {
      if (frame.event !== 'session:updated' || frame.payload.sessionId !== sessionId) return
      const mine = seq.current
      api.getSession(sessionId, { messages: false })
        .then((s) => { if (seq.current === mine) accept(parseFallbackView(s.fallback)) })
        .catch(() => {})
    })
  }, [subscribe, sessionId])

  const pick = (value: string) => {
    const mode = value as SessionFallbackMode
    if (!local || mode === local.mode) return
    const base = confirmed.current ?? local
    const mine = ++seq.current
    inFlight.current++
    setLocal(withMode(local, mode))
    setError(null)
    api.updateSession(sessionId, { fallbackMode: mode })
      .then((res) => {
        if (seq.current !== mine) return
        const next = parseFallbackView(res?.fallback) ?? withMode(base, mode)
        confirmed.current = next
        setLocal(next)
      })
      .catch((err) => {
        if (seq.current !== mine) return
        setLocal(base)
        setError(err instanceof Error ? err.message : 'Fallback mode update failed')
      })
      .finally(() => { if (seq.current === mine) inFlight.current = 0 })
  }
  return { local, error, pick }
}

function FallbackModeMenu({ local, error, onPick }: { local: SessionFallbackView; error: string | null; onPick: (mode: string) => void }) {
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
  const { local, error, pick } = useFallbackMode(sessionId, view, subscribe)
  if (!local) return null
  const text = fallbackChipText(local)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid="fallback-mode-chip"
          disabled={disabled}
          title={fallbackChipTitle(local)}
          aria-label={`${fallbackChipTitle(local)}. Change fallback mode`}
          className="group inline-flex min-h-[40px] md:min-h-0 min-w-[28px] shrink items-center gap-1 rounded-lg border-none bg-transparent px-1.5 py-1 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
        >
          <ArrowRightLeftIcon aria-hidden className="size-3 shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)] transition-colors @max-[340px]/composer:hidden">
            {text}
          </span>
          {local.mode === 'fallback-children' && (
            <span
              data-testid="fallback-children-marker"
              title="Child sessions inherit this fallback"
              className="shrink-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] @max-[340px]/composer:hidden"
            >
              + children
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-lg)] border-0 bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        <FallbackModeMenu local={local} error={error} onPick={pick} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
