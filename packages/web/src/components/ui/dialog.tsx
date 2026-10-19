/**
 * A dialog over React Aria's modal, under the parts and props the Radix dialog had. What is always loaded is
 * this file and the three beside it: the open state and the trigger's wiring (`dialog-root.tsx`), the title and
 * description's ids, the box's host (`dialog-content.tsx`) and the loader (`dialog-load.ts`) of everything that
 * is React Aria (`dialog-popup.tsx`), which a dialog in the shell would otherwise put on the initial path.
 * The popup is fetched when the pointer reaches a trigger, a trigger takes focus or is touched, and once when
 * the page has gone idle, so it is normally there by the press; a dialog opened before it lands shows the
 * scrim, and one whose chunk cannot be fetched closes.
 *
 * Same parts and props as the Radix dialog, except:
 *  - `DialogPortal` and `DialogOverlay` are gone (nothing imported them: the content draws its own scrim and
 *    portals itself), and `modal={false}` is accepted and ignored: a dialog is always modal.
 *  - `onEscapeKeyDown` and `onOpenAutoFocus` get a native event, as they did, but no `onCloseAutoFocus`
 *    (React Aria returns focus, and a trigger gets it back when the browser would not have given it).
 *  - `DialogContent` takes `material="none"` for a dialog that draws its own surface; the default is the
 *    overlay glass. `role="alertdialog"` and `dismissable={false}` make a confirmation that a press outside
 *    does not dismiss.
 */

import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { DialogClose, useDialogRoot } from "./dialog-root"
export { Dialog, DialogClose, DialogTrigger } from "./dialog-root"
export { DialogContent } from "./dialog-content"
export { preloadDialogPopup } from "./dialog-load"

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogClose asChild>
          <Button variant="outline">Close</Button>
        </DialogClose>
      )}
    </div>
  )
}

/** Marks a part as present for as long as it is mounted, so the dialog names itself by it only then. */
function usePresence(set: (present: boolean) => void) {
  React.useLayoutEffect(() => {
    set(true)
    return () => set(false)
  }, [set])
}

function DialogTitle({ className, id, ...props }: React.ComponentProps<"h2">) {
  const root = useDialogRoot()
  usePresence(root.setHasTitle)
  return (
    <h2
      data-slot="dialog-title"
      id={id ?? root.titleId}
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({ className, id, ...props }: React.ComponentProps<"p">) {
  const root = useDialogRoot()
  usePresence(root.setHasDescription)
  return (
    <p
      data-slot="dialog-description"
      id={id ?? root.descriptionId}
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}


export {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
}
