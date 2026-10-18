import {
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { cn } from "@/lib/utils"
import { MIN_ZOOM } from "@/lib/zoom-pan"
import { PreviewBar, PreviewSteppers } from "./media-preview-chrome"
import {
  closePreview,
  stepPreview,
  usePreview,
  type PreviewItem,
  type PreviewSet,
} from "./media-preview-store"
import { DOCK_EASE, OPEN_MS } from "./situation-choreography"
import type { AnswerHandler } from "./situation-payload"
import { usePrefersReducedMotion } from "./use-reduced-motion"
import { useMediaPreview, type PreviewEntrance } from "./use-media-preview"
import { useSheetDrag, type SheetDrag } from "./use-sheet-drag"
import { useZoomPan, type ZoomPan } from "./use-zoom-pan"

/**
 * A media set at full size, over the sheet that raised it and under the orb, so
 * a decision can be looked at properly without the session going anywhere. It
 * grows out of the thumbnail that was tapped and steps across the whole set
 * without ever coming down — which is what lets A, B and C be compared.
 */

const MEDIA_BOX = "block max-h-[calc(100dvh-112px)] max-w-[calc(100vw-24px)] w-auto object-contain sm:max-w-[calc(100vw-160px)]"

/** The width allowance `MEDIA_BOX` caps at, as a variable a clip can size from. */
const CLIP_ALLOWANCE = "[--clip-allowance:calc(100vw-24px)] sm:[--clip-allowance:calc(100vw-160px)]"

/**
 * The box a clip fills once its own shape is known: as large as the allowance
 * permits, at the clip's ratio. Natural size cannot be used the way it is for a
 * picture, because a clip has two natural sizes — the poster's while the still
 * is showing, the frames' from the moment it plays — and the box would collapse
 * between them, sliding the native controls out from under a finger already on
 * Pause and leaving that press to land on the scrim.
 */
function clipBox(ratio: number): CSSProperties {
  return {
    width: `min(var(--clip-allowance), calc((100dvh - 112px) * ${ratio}))`,
    aspectRatio: String(ratio),
  }
}

/**
 * Controls, sound and all: the point of a full preview is that the clip can
 * actually be scrubbed, paused and replayed rather than just watched. Those
 * controls are pointer gestures of their own, so the clip keeps its pointers
 * instead of the stage taking them for drag-to-close.
 */
function PreviewClip({ item }: { item: PreviewItem }) {
  const [ratio, setRatio] = useState<number | null>(null)

  return (
    <video
      data-preview-media="video"
      src={item.src}
      poster={item.poster}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => {
        const { videoWidth, videoHeight } = event.currentTarget
        if (videoWidth > 0 && videoHeight > 0) setRatio(videoWidth / videoHeight)
      }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={item.label}
      style={ratio === null ? undefined : clipBox(ratio)}
      className={cn(MEDIA_BOX, CLIP_ALLOWANCE, "rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]")}
    />
  )
}

function PreviewMedia({ item, zoomPan }: { item: PreviewItem; zoomPan: ZoomPan }) {
  const transform = `translate(${zoomPan.pan.x}px, ${zoomPan.pan.y}px) scale(${zoomPan.zoom})`

  // Keyed, so stepping to another clip starts from that clip's shape rather
  // than carrying the last one's over until its metadata arrives.
  if (item.kind === "video") return <PreviewClip key={item.id} item={item} />

  return (
    <img
      ref={zoomPan.mediaRef}
      data-preview-media="image"
      data-preview-zoom={String(zoomPan.zoom)}
      src={item.src}
      alt={item.label}
      decoding="async"
      draggable={false}
      onDoubleClick={zoomPan.toggleZoom}
      {...zoomPan.handlers}
      style={{ transform, touchAction: "none" }}
      className={cn(
        MEDIA_BOX,
        "select-none rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]",
        zoomPan.zoom > MIN_ZOOM ? (zoomPan.panning ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
        zoomPan.panning ? "" : "transition-transform duration-150 ease-out",
      )}
    />
  )
}

/**
 * The stage wears the entrance transform first and the drag transform after,
 * and only eases once it is settled: mid-gesture it has to track the finger.
 */
function stageStyle(entrance: PreviewEntrance, drag: SheetDrag, reduce: boolean): CSSProperties {
  const easing = entrance.phase === "open" && !drag.dragging && !reduce
  return {
    transform: entrance.flip ?? (drag.offsetY === 0 ? undefined : `translateY(${drag.offsetY}px)`),
    transitionProperty: easing ? "transform" : "none",
    transitionDuration: easing ? `${OPEN_MS}ms` : "0ms",
    transitionTimingFunction: DOCK_EASE,
  }
}

/**
 * Anywhere but the media itself is the way out, the same as the sheet's scrim —
 * except where the press began somewhere else. Where it went down is read in the
 * capture phase, ahead of the media's own handlers, so a press that began on the
 * clip's controls stays the clip's however the layout moves under it and
 * whatever the eventual click reports as its target. A click that arrived
 * without a press of its own — from assistive technology, or from a test — is
 * nobody else's and still counts.
 */
function useScrimDismiss() {
  const pressedOn = useRef<EventTarget | null>(null)
  return {
    onPointerDownCapture(event: ReactPointerEvent<HTMLElement>) {
      pressedOn.current = event.target
    },
    onClick(event: ReactMouseEvent<HTMLElement>) {
      const pressed = pressedOn.current
      pressedOn.current = null
      if (event.target !== event.currentTarget) return
      if (pressed && pressed !== event.currentTarget) return
      closePreview()
    },
  }
}

function PreviewOverlay({ preview, onPick }: { preview: PreviewSet; onPick: AnswerHandler }) {
  const reduce = usePrefersReducedMotion()
  const entrance = useMediaPreview(preview.origin, reduce)
  const { stageRef, panelRef } = entrance
  const item = preview.items[preview.index]
  const zoomPan = useZoomPan(item.id)
  // A picture with somewhere to pan owns the pointer; otherwise a drag closes.
  const drag = useSheetDrag(closePreview, zoomPan.zoom === MIN_ZOOM)
  const scrim = useScrimDismiss()

  return (
    <div data-media-preview={item.id} className="pointer-events-auto fixed inset-0 z-[100]">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={item.label}
        tabIndex={-1}
        {...scrim}
        className={cn(
          "absolute inset-0 flex items-center justify-center outline-none",
          // A full-screen sheet: opaque, no blur (a full-viewport blur is the costliest surface there is).
          "bg-[var(--material-thick-opaque)]",
        )}
      >
        <div
          ref={stageRef}
          data-preview-stage
          {...drag.handlers}
          style={stageStyle(entrance, drag, reduce)}
          className="flex max-h-full max-w-full touch-none will-change-transform"
        >
          <PreviewMedia item={item} zoomPan={zoomPan} />
        </div>
        {preview.items.length > 1 && <PreviewSteppers onStep={stepPreview} />}
        <PreviewBar item={item} zoomPan={zoomPan} onPick={onPick} onClose={closePreview} />
      </div>
    </div>
  )
}

/**
 * Remounted per open rather than retained: the entrance is measured from the
 * thumbnail it was raised from, and a fresh mount is what guarantees it starts
 * from that measurement instead of from whatever the last one left behind.
 */
export function MediaPreview({ onPick }: { onPick: AnswerHandler }) {
  const preview = usePreview()
  if (!preview) return null
  return <PreviewOverlay preview={preview} onPick={onPick} />
}
