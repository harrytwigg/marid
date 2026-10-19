import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { MediaPreview } from "./media-preview"
import { usePreview } from "./media-preview-store"
import {
  CLOSE_MS,
  DOCK_EASE,
  MOBILE_TITLE_GUTTER,
  OPEN_MS,
  type SheetRect,
} from "./situation-choreography"
import { SITUATION_RENDERERS } from "./situation-renderers"
import type { AnswerHandler, Situation } from "./situation-payload"
import { useSheetDrag, type SheetDrag } from "./use-sheet-drag"
import { usePrefersReducedMotion } from "./use-reduced-motion"
import { useSituationSheet, type SheetPhase } from "./use-situation-sheet"

/**
 * The decision surface: a sheet that rises beside the parked orb over a dimmed
 * page. It knows nothing about what it is showing — the registry resolves the
 * body from the payload's own discriminant, so a new kind never lands here.
 *
 * The phase machine and the modality live in `use-situation-sheet`; what is left
 * here is the shape on screen.
 */

/** Title, payload, closing line. The only place text lives in this surface. */
function SheetContent({
  shown,
  onAnswer,
  drag,
}: {
  shown: Situation
  onAnswer: AnswerHandler
  drag: SheetDrag
}) {
  const { Render } = SITUATION_RENDERERS[shown.payload.kind]
  return (
    <>
      {/* The pill and the header are both the handle: the pill names the gesture
          and the header is the part of the sheet a hand already rests on. */}
      <div
        data-situation-grabber
        aria-hidden
        {...drag.handlers}
        className="mx-auto mt-[var(--space-2)] h-1 w-9 shrink-0 cursor-grab touch-none rounded-[2px] bg-[var(--fill-primary)]"
      />
      <header
        {...drag.handlers}
        className="shrink-0 cursor-grab touch-none select-none px-[var(--space-5)] pb-[var(--space-3)] pr-[var(--situation-orb-gutter)] pt-[var(--space-4)] lg:pr-[var(--space-5)]"
      >
        <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          {shown.title}
        </h2>
        {shown.hint && (
          <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
            {shown.hint}
          </p>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--space-5)]">
        {/* The registry key is the payload's own discriminant, so the renderer
            this resolves to is the one written for exactly this payload. */}
        <Render payload={shown.payload as never} onAnswer={onAnswer} />
      </div>
      <footer className="shrink-0 px-[var(--space-5)] pb-[calc(var(--space-4)+env(safe-area-inset-bottom))] pt-[var(--space-3)]">
        {shown.footer && (
          <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {shown.footer}
          </p>
        )}
      </footer>
    </>
  )
}

/** The dimmed page behind the sheet; tapping it is a dismissal, not an answer. */
function SheetScrim({ visible, durationMs, onDismiss }: { visible: boolean; durationMs: number; onDismiss: () => void }) {
  return (
    <button
      type="button"
      aria-label="Dismiss"
      tabIndex={-1}
      onClick={onDismiss}
      style={{ transitionDuration: `${durationMs}ms` }}
      className={cn(
        "absolute inset-0 cursor-default border-none bg-[var(--scrim)] p-0",
        "transition-opacity ease-[var(--ease-smooth)]",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  )
}

interface SituationSheetProps {
  /** Null keeps the sheet closed; a value opens it and drives the exit. */
  situation: Situation | null
  onAnswer: AnswerHandler
  onDismiss: () => void
  /** The sheet's untransformed box, for the orb's dock point. Null once closed. */
  onLayout?: (rect: SheetRect | null) => void
}

/** A drag gets no transition at all: it tracks the pointer directly. */
function sheetDurationMs(phase: SheetPhase, reduce: boolean, dragging: boolean): number {
  if (dragging || reduce) return 0
  return phase === "closing" ? CLOSE_MS : OPEN_MS
}

/** Scaled through its entrance and exit, following the finger in between. */
function panelStyle(phase: SheetPhase, durationMs: number, drag: SheetDrag): CSSProperties {
  const shrunk = phase === "entering" || phase === "closing"
  return {
    "--situation-orb-gutter": `${MOBILE_TITLE_GUTTER}px`,
    transitionDuration: `${durationMs}ms`,
    transitionTimingFunction: DOCK_EASE,
    transform: shrunk
      ? "scale(0.6)"
      : drag.offsetY === 0
        ? undefined
        : `translateY(${drag.offsetY}px)`,
  } as CSSProperties
}

export function SituationSheet({ situation, onAnswer, onDismiss, onLayout }: SituationSheetProps) {
  const reduce = usePrefersReducedMotion()
  // A preview over the sheet owns the keyboard: Escape has to close that first,
  // and Tab must not be pulled back into the panel underneath it.
  const previewOpen = usePreview() !== null
  const { shown, phase, panelRef } = useSituationSheet(
    situation,
    reduce,
    !previewOpen,
    onDismiss,
    onLayout,
  )
  const drag = useSheetDrag(onDismiss)

  if (!shown) return null

  const settled = phase === "open"
  const durationMs = sheetDurationMs(phase, reduce, drag.dragging)

  return (
    <div data-situation-phase={phase} className="pointer-events-auto fixed inset-0 z-[90]">
      <SheetScrim visible={settled} durationMs={durationMs} onDismiss={onDismiss} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={shown.title}
        tabIndex={-1}
        data-situation-sheet={shown.id}
        style={panelStyle(phase, durationMs, drag)}
        className={cn(
          "absolute inset-x-0 bottom-0 mx-auto flex max-h-[80dvh] w-full flex-col outline-none",
          "glass-overlay rounded-t-[var(--radius-2xl)]",
          "origin-top-right transition-[transform,opacity]",
          "lg:bottom-5 lg:max-w-[816px] lg:origin-right lg:rounded-[var(--radius-2xl)]",
          settled ? "opacity-100" : "opacity-0",
        )}
      >
        <SheetContent shown={shown} onAnswer={onAnswer} drag={drag} />
      </aside>
      <MediaPreview onPick={onAnswer} />
    </div>
  )
}
