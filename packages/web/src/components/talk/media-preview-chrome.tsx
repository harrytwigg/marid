import type { ReactNode } from "react"
import { ChevronLeft, ChevronRight, X, ZoomIn } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import { MIN_ZOOM } from "@/lib/zoom-pan"
import type { PreviewItem } from "./media-preview-store"
import type { ZoomPan } from "./use-zoom-pan"

/**
 * The controls around a full-size picture: the two chevrons that walk the set,
 * and the floating bar that names what is on screen and carries the answer.
 * Same floating-material chrome as the attachment lightbox, so a preview reads
 * as the same object wherever the operator meets one.
 */

const ROUND_BUTTON = cn(
  "grid size-10 flex-none cursor-pointer place-items-center rounded-full border-none",
  "text-[var(--text-secondary)] outline-none transition-transform duration-150 ease-out",
  "hover:text-[var(--text-primary)] active:scale-[0.96]",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
)

// The opaque overlay material, no blur: these sit over moving media on a sheet that is itself a glass surface, and blur does not nest.
const FLOATING = "bg-[var(--material-thick-opaque)] shadow-[var(--shadow-overlay)]"

export function PreviewSteppers({ onStep }: { onStep: (direction: -1 | 1) => void }) {
  return (
    <>
      <button
        type="button"
        data-preview-step="prev"
        aria-label="Previous"
        onClick={() => onStep(-1)}
        className={cn(ROUND_BUTTON, FLOATING, "absolute left-3 top-1/2 -translate-y-1/2 sm:left-6")}
      >
        <ChevronLeft size={19} aria-hidden />
      </button>
      <button
        type="button"
        data-preview-step="next"
        aria-label="Next"
        onClick={() => onStep(1)}
        className={cn(ROUND_BUTTON, FLOATING, "absolute right-3 top-1/2 -translate-y-1/2 sm:right-6")}
      >
        <ChevronRight size={19} aria-hidden />
      </button>
    </>
  )
}

/** The icon controls that live inside the bar, as against beside the picture. */
function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(ROUND_BUTTON, "hover:bg-[var(--fill-secondary)]")}
    >
      {children}
    </button>
  )
}

interface PreviewBarProps {
  item: PreviewItem
  zoomPan: ZoomPan
  /** Called with the id of the item on screen; the preview closes either way. */
  onPick: (choiceId: string) => void
  onClose: () => void
}

export function PreviewBar({ item, zoomPan, onPick, onClose }: PreviewBarProps) {
  // A player has nothing to zoom into, so it gets no control for it.
  const zoomable = item.kind === "image"
  return (
    // Centred by a full-width row rather than by `left-1/2`: an absolutely
    // positioned box offset from the left only ever gets the remaining half of
    // the viewport to size itself in, which on a phone truncates the label.
    <div className="absolute inset-x-3 bottom-[max(16px,env(safe-area-inset-bottom))] flex justify-center">
      <div
        className={cn(
          FLOATING,
          "flex max-w-full items-center gap-1 rounded-full py-1.5 pl-4 pr-1.5",
        )}
      >
        <span className="min-w-0 truncate pr-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {item.label}
        </span>
        <button
          type="button"
          data-preview-pick
          onClick={() => {
            onClose()
            onPick(item.id)
          }}
          className={cn(
            "h-9 flex-none cursor-pointer rounded-full border-none px-4",
            "bg-[var(--accent-fill)] text-[length:var(--text-footnote)] text-[var(--accent)]",
            "transition-transform duration-150 ease-out active:scale-[0.96]",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]",
          )}
        >
          Pick this
        </button>
        {zoomable && (
          <BarButton
            label={zoomPan.zoom === MIN_ZOOM ? "Zoom in" : "Reset zoom"}
            onClick={zoomPan.toggleZoom}
          >
            <ZoomIn size={16} aria-hidden />
          </BarButton>
        )}
        <BarButton label="Close preview" onClick={onClose}>
          <X size={16} aria-hidden />
        </BarButton>
      </div>
    </div>
  )
}
