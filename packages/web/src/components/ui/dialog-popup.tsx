import * as React from "react"
import { Dialog as AriaDialog } from "react-aria-components/Dialog"
import { Modal, ModalOverlay } from "react-aria-components/Modal"
import { useObjectRef } from "react-aria/useObjectRef"

import { cn } from "@/lib/utils"

/**
 * Everything of the dialogs that is React Aria, and the one modal the app's dialogs, sheets and lightbox are
 * drawn in. `dialog.tsx` loads it the first time a dialog opens (a dialog sits in the always-loaded shell, where
 * the modal's focus containment, scroll lock and overlay stack would add to the initial path); a module that is
 * itself in a lazy chunk (the Todo dialogs and sheets) imports it directly.
 *
 * What React Aria's modal does that the Radix dialog did, and more: focus moves in on open and is contained, then
 * returns on close; Escape and a press on the scrim close it; the page behind is hidden from assistive tech and
 * cannot scroll (iOS included). Unlike Radix it stacks: a popover, menu or select opened inside it, or a second
 * modal opened over it, sits above it and gets the keyboard and the press first, with no portal to route.
 *
 * Three elements, because React Aria watches the first two for the exit animation and the box is the third:
 *   scrim   `ModalOverlay`  fills the viewport (the visual one, so a phone keyboard does not push it off), fades.
 *   mover   `Modal`         fills the scrim, does not take presses, and carries the box's enter/exit motion.
 *   box     `Dialog`        the visible dialog, where `className` lands. It is `absolute` in the mover, so the
 *                           positioning classes a call site gave a Radix content (`inset-x-3 bottom-3`,
 *                           `top-1/2 left-1/2 -translate-*`) read the same.
 * The motion is on the mover rather than the box because React Aria asks only those two elements what they are
 * animating before it unmounts them, and only a box that is not itself animating can keep a `translate` centring it.
 */

/** How the box arrives and leaves; each pair is a keyframe in `globals.css`, whose durations collapse under reduced motion. */
const MOTION = {
  pop: "motion-safe:data-[entering]:animate-pop-in motion-safe:data-[exiting]:animate-pop-out",
  sheet: "motion-safe:data-[entering]:animate-sheet-in motion-safe:data-[exiting]:animate-sheet-out",
  "sheet-pop":
    "motion-safe:data-[entering]:animate-sheet-in motion-safe:data-[exiting]:animate-sheet-out sm:motion-safe:data-[entering]:animate-pop-in sm:motion-safe:data-[exiting]:animate-pop-out",
} as const

export type DialogMotion = keyof typeof MOTION

const SCRIM_CLASS =
  "fixed inset-0 z-50 h-(--visual-viewport-height) bg-[var(--scrim)] motion-safe:data-[entering]:animate-overlay-in motion-safe:data-[exiting]:animate-overlay-out"

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type DialogPopupProps = Omit<React.ComponentProps<"section">, "role"> & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Whether a press on the scrim closes it. */
  dismissable?: boolean
  motion?: DialogMotion
  /** `alertdialog` for a confirmation that interrupts, which a screen reader announces with its description. */
  role?: "dialog" | "alertdialog"
  overlayClassName?: string
  /** Escape asked to close. Preventing the default keeps it open; leaving it closes. A popover or menu inside
   *  answers its own Escape first and this never sees it. */
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  /** Focus is about to move into the dialog. Preventing the default leaves it on the dialog itself, which
   *  React Aria has already focused; otherwise it goes to the first control, as the Radix dialog's did. */
  onOpenAutoFocus?: (event: Event) => void
}

/** The boxes that are open, innermost last: Escape belongs to the last. */
const openBoxes: HTMLElement[] = []

/** Escape closes unless the caller said otherwise. Heard on the document, as the Radix dialog heard it, because
 *  focus can be on the body (a press on a part of the box that takes none) and the key must still get out; only the
 *  innermost box answers. A popover or menu inside answers its own Escape first and stops it, so it never gets here. */
function useEscape(
  ref: React.RefObject<HTMLElement | null>,
  onEscapeKeyDown: DialogPopupProps["onEscapeKeyDown"],
  close: () => void,
) {
  const latest = React.useRef({ onEscapeKeyDown, close })
  latest.current = { onEscapeKeyDown, close }
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    openBoxes.push(node)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || openBoxes[openBoxes.length - 1] !== node) return
      latest.current.onEscapeKeyDown?.(event)
      if (event.defaultPrevented) return
      event.preventDefault()
      latest.current.close()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      openBoxes.splice(openBoxes.indexOf(node), 1)
    }
  }, [ref])
}

/** React Aria focuses the box on mount; the Radix dialog's content focused its first control, which is where a
 *  caller's own field or button expects to find the keyboard, unless it asked to leave it. */
function useOpenAutoFocus(ref: React.RefObject<HTMLElement | null>, onOpenAutoFocus: DialogPopupProps["onOpenAutoFocus"]) {
  const latest = React.useRef(onOpenAutoFocus)
  latest.current = onOpenAutoFocus
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const event = new Event("dialog.openAutoFocus", { cancelable: true })
    latest.current?.(event)
    if (event.defaultPrevented) return
    // A control that took focus itself (autoFocus) has it already.
    if (document.activeElement && document.activeElement !== node && node.contains(document.activeElement)) return
    node.querySelector<HTMLElement>(TABBABLE)?.focus({ preventScroll: true })
  }, [ref])
}

function PopupBox({
  ref,
  className,
  children,
  onKeyDown,
  onEscapeKeyDown,
  onOpenAutoFocus,
  close,
  ...props
}: Omit<DialogPopupProps, "open" | "onOpenChange" | "dismissable" | "motion" | "overlayClassName"> & { close: () => void }) {
  const box = useObjectRef(ref as React.Ref<HTMLElement>)
  useEscape(box, onEscapeKeyDown, close)
  useOpenAutoFocus(box, onOpenAutoFocus)
  return (
    <AriaDialog ref={box as React.RefObject<HTMLElement>} className={cn("pointer-events-auto outline-none", className)} {...props}>
      {/* React Aria's dialog passes on no key handler; one wrapper that takes no box of its own gives the box's
          content the `onKeyDown` a Radix content took. It is always there, so adding or dropping the handler on an
          open dialog does not remount what is inside. */}
      <div className="contents" onKeyDown={onKeyDown}>{children}</div>
    </AriaDialog>
  )
}

export default function DialogPopup({
  open,
  onOpenChange,
  dismissable = true,
  motion = "pop",
  overlayClassName,
  onEscapeKeyDown,
  ...box
}: DialogPopupProps) {
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={onOpenChange}
      isDismissable={dismissable}
      // Escape is the box's to answer (`useEscape`), so a caller can keep the dialog open on it.
      isKeyboardDismissDisabled
      data-slot="dialog-overlay"
      className={cn(SCRIM_CLASS, overlayClassName)}
    >
      <Modal className={cn("pointer-events-none absolute inset-0 outline-none", MOTION[motion])}>
        <PopupBox close={close} onEscapeKeyDown={onEscapeKeyDown} {...box} />
      </Modal>
    </ModalOverlay>
  )
}
