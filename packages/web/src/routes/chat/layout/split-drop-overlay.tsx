import type { SplitDropPlacement } from './use-split-grid-add'

/** chat-grid-drop.tsx ChatGridDropOverlay, carrying the split regions ('center' included). The
 * test id and data attributes are the ones the chat-grid-drop e2e suite reads. */
export function SplitDropOverlay({ placement }: { placement: SplitDropPlacement | null }) {
  if (!placement) return null
  const { previewRect } = placement
  return (
    <div
      data-testid="chat-grid-drop-zone"
      data-drop-region={placement.region}
      data-drop-index={placement.targetIndex}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-30 rounded-[var(--radius-lg)] bg-[color-mix(in_srgb,var(--accent)_18%,var(--bg-secondary))] opacity-100 shadow-[var(--shadow-card)]"
      style={{
        width: previewRect.width,
        height: previewRect.height,
        transform: `translate3d(${previewRect.left}px, ${previewRect.top}px, 0)`,
      }}
    />
  )
}
