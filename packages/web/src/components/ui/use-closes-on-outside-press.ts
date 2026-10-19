import * as React from "react"

/**
 * Closes a non-modal overlay on a press that lands outside it. React Aria's
 * modal overlays put an underlay over the page, which swallows the press and,
 * being a React child of the trigger's ancestors, hands it to their handlers (a
 * chat pane would take focus from the pane the user clicked). A non-modal one
 * leaves the page live, so the press goes on to what it landed on, and the
 * overlay closes here instead.
 *
 * Listens in the capture phase, so a handler that stops propagation cannot hide
 * the press from it. `isInside` says which targets belong to the overlay (its
 * surface, its trigger, and for a menu its submenus).
 */
export function useClosesOnOutsidePress({
  isOpen,
  close,
  isInside,
}: {
  isOpen: boolean
  close: (() => void) | undefined
  isInside: (target: Node) => boolean
}) {
  const inside = React.useRef(isInside)
  inside.current = isInside
  React.useEffect(() => {
    if (!isOpen || !close) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && inside.current(target)) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [isOpen, close])
}
