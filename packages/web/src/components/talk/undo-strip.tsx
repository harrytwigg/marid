import { useEffect, useState, type CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { readPark } from "./orb-park"
import { ORB_EDGE_GAP, ORB_SIZE } from "./situation-choreography"
import { takeUndo, useUndoOffer } from "./talk-undo-store"
import { usePrefersReducedMotion } from "./use-reduced-motion"

/**
 * The fast lane's second text surface: what just happened, and the way back.
 *
 * Deliberately NOT a sheet. The sheet is modal because a decision has to be
 * made; this must not be, because the operator has already moved on — it takes
 * no focus, deactivates nothing, and leaves on its own. It keeps clear of
 * whichever bottom corner the orb is parked in, so the two never want the same
 * thumb.
 */

/** Whole-second countdown, so a quarter-second tick is as slow as it can be
 *  without the number visibly lagging the clock. */
const TICK_MS = 250
const ENTRANCE_MS = 220

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
}

/** Re-reads the clock instead of counting down from a remembered number, so a
 *  backgrounded tab comes back showing the truth rather than where it paused. */
function useCountdown(expiresAt: number): number {
  const [left, setLeft] = useState(() => secondsLeft(expiresAt))
  useEffect(() => {
    setLeft(secondsLeft(expiresAt))
    const tick = setInterval(() => setLeft(secondsLeft(expiresAt)), TICK_MS)
    return () => clearInterval(tick)
  }, [expiresAt])
  return left
}

/** The side the orb is resting on, if it is resting along the bottom at all. */
function orbGutter(): CSSProperties {
  const park = readPark()
  const gutter = `${ORB_SIZE + ORB_EDGE_GAP * 2}px`
  if (park === "bottom-right") return { right: gutter }
  if (park === "bottom-left") return { left: gutter }
  return {}
}

function UndoButton({ secondsLeft: left, onUndo }: { secondsLeft: number; onUndo: () => void }) {
  return (
    <button
      type="button"
      data-talk-undo
      onClick={onUndo}
      className={cn(
        "h-[34px] shrink-0 cursor-pointer rounded-full border-none bg-[var(--accent-fill)] px-[var(--space-3)]",
        "text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--accent)]",
        "transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] active:scale-[0.97]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
      )}
    >
      Undo <span className="tabular-nums text-[var(--text-tertiary)]">{left}</span>
    </button>
  )
}

/** A reversal that failed leaves the strip up with the reason, because the
 *  operator asked for something that did not happen and nothing else will say so. */
function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      onClick={onDismiss}
      className={cn(
        "h-[34px] w-[34px] shrink-0 cursor-pointer rounded-full border-none bg-[var(--fill-tertiary)]",
        "text-[length:var(--text-subheadline)] text-[var(--text-secondary)]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
      )}
    >
      ✕
    </button>
  )
}

/** The strip's one line of text: what just happened, or why the way back was
 *  not taken. */
function StripLine({ failure, performed }: { failure: string | null; performed: string | undefined }) {
  return (
    <p
      role="status"
      className={cn(
        "min-w-0 flex-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]",
        // A performed line is one short sentence whose shape the operator
        // already knows, so it clips rather than growing the strip. A failure
        // is the gateway's reason and the only account of it there is: at 390px
        // clipping would show none of it, so it wraps instead.
        failure ? "break-words" : "truncate",
      )}
    >
      {failure ?? performed}
    </p>
  )
}

export function UndoStrip() {
  const offer = useUndoOffer()
  const reduce = usePrefersReducedMotion()
  const [failure, setFailure] = useState<string | null>(null)
  // Hooks run on every render, so an absent offer is handled after them.
  const left = useCountdown(offer?.expiresAt ?? 0)

  useEffect(() => {
    if (offer) setFailure(null)
  }, [offer])

  if (!offer && !failure) return null

  async function undo() {
    const outcome = await takeUndo()
    if (!outcome.ok) setFailure(outcome.error)
  }

  return (
    <div
      data-talk-undo-strip
      style={{
        ...orbGutter(),
        ...(reduce ? {} : { animation: `jinn-undo-rise ${ENTRANCE_MS}ms var(--ease-smooth) both` }),
      }}
      className={cn(
        "pointer-events-auto fixed inset-x-[var(--space-3)] z-[80]",
        // Above the mobile tab bar, never over it: the strip takes pointer
        // events, so overlapping the bar would swallow taps meant for a
        // destination. Same measurement the orb parks by — the bar's 49px tap
        // target plus the padding `mobile-tab-bar.tsx` adds below it. The bar is
        // `lg:hidden`, so from `lg` up the strip goes back to the screen edge.
        "bottom-[calc(49px+max(var(--safe-bottom),6px)+var(--space-3))] lg:bottom-[calc(var(--space-3)+var(--safe-bottom))]",
        "flex max-w-[420px] items-center gap-[var(--space-3)]",
        // The overlay material rather than the sheet's tint: the sheet reads as
        // a surface because of the scrim behind it, and this has none, so it has
        // to lift off the page instead of tinting it.
        "glass-overlay rounded-[var(--radius-xl)] py-[var(--space-2)] pl-[var(--space-4)] pr-[var(--space-2)]",
      )}
    >
      <StripLine failure={failure} performed={offer?.performed} />
      {offer && <UndoButton secondsLeft={left} onUndo={() => void undo()} />}
      {failure && <DismissButton onDismiss={() => setFailure(null)} />}
    </div>
  )
}
