import * as React from "react"
import { XIcon } from "lucide-react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import type { DialogPopupProps } from "./dialog-popup"
import { returnFocusTo } from "./menu-focus"
import { scheduleMenuWarmup } from "./menu-warmup"

/**
 * A dialog over React Aria's modal, under the parts and props the Radix dialog had. What is always loaded is
 * this file: the open state, the trigger's wiring, the title and description's ids and the loader of everything
 * that is React Aria (`dialog-popup.tsx`), which a dialog in the shell would otherwise put on the initial path.
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

type DialogRoot = {
  open: boolean
  /** Whether it has been open: from then on the popup stays mounted, so React Aria can run the exit. */
  hasOpened: boolean
  change: (open: boolean) => void
  triggerRef: React.RefObject<HTMLElement | null>
  contentId: string
  titleId: string
  descriptionId: string
  hasTitle: boolean
  setHasTitle: (present: boolean) => void
  hasDescription: boolean
  setHasDescription: (present: boolean) => void
}

const DialogContext = React.createContext<DialogRoot | null>(null)

function useDialogRoot(): DialogRoot {
  const root = React.useContext(DialogContext)
  if (!root) throw new Error("A dialog part must be inside a Dialog")
  return root
}

type DialogProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** Accepted for the plugin SDK's sake; a dialog is always modal. */
  modal?: boolean
  children?: React.ReactNode
}

let warmupScheduled = false

/** Asks, once per page, for the popup to be fetched when the page is idle (production builds only). */
function warmPopupOnce() {
  if (warmupScheduled || !import.meta.env.PROD || typeof window === "undefined") return
  warmupScheduled = true
  scheduleMenuWarmup(() => void preloadDialogPopup().catch(() => {}), { document, window })
}

/** The popup module, loaded once. A failed load is forgotten, so the next open tries again. */
type PopupModule = typeof import("./dialog-popup")
let popup: PopupModule | null = null
let loading: Promise<PopupModule> | null = null

export function preloadDialogPopup(): Promise<PopupModule> {
  loading ??= import("./dialog-popup").then(
    (module) => (popup = module),
    (error) => {
      loading = null
      throw error
    },
  )
  return loading
}

/** Starts the fetch from a trigger's pointer, focus or touch; a failed one is reported to whoever opens the dialog. */
const preloadQuietly = () => void preloadDialogPopup().catch(() => {})

function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen)
  const [everOpen, setEverOpen] = React.useState(false)
  const [hasTitle, setHasTitle] = React.useState(false)
  const [hasDescription, setHasDescription] = React.useState(false)
  const triggerRef = React.useRef<HTMLElement | null>(null)
  const isOpen = open ?? uncontrolled
  if (isOpen && !everOpen) setEverOpen(true)
  const onChange = React.useRef(onOpenChange)
  onChange.current = onOpenChange
  const change = React.useCallback((next: boolean) => {
    setUncontrolled(next)
    onChange.current?.(next)
    // React Aria puts focus back where it was, but not in a browser whose buttons take none from a press.
    if (!next) returnFocusTo(triggerRef.current)
  }, [])
  const id = React.useId()
  React.useEffect(warmPopupOnce, [])
  const root = React.useMemo<DialogRoot>(
    () => ({
      open: isOpen,
      hasOpened: everOpen || isOpen,
      change,
      triggerRef,
      contentId: `${id}-content`,
      titleId: `${id}-title`,
      descriptionId: `${id}-description`,
      hasTitle,
      setHasTitle,
      hasDescription,
      setHasDescription,
    }),
    [isOpen, everOpen, change, id, hasTitle, hasDescription],
  )
  return <DialogContext.Provider value={root}>{children}</DialogContext.Provider>
}

function DialogTrigger({
  asChild = false,
  onClick,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ref,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const root = useDialogRoot()
  const Comp = asChild ? Slot.Root : "button"
  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      root.triggerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [root.triggerRef, ref],
  )
  return (
    <Comp
      ref={setRef}
      data-slot="dialog-trigger"
      type={asChild ? undefined : "button"}
      aria-haspopup="dialog"
      aria-expanded={root.open}
      aria-controls={root.open ? root.contentId : undefined}
      data-state={root.open ? "open" : "closed"}
      onPointerEnter={(event: React.PointerEvent<HTMLButtonElement>) => { preloadQuietly(); onPointerEnter?.(event) }}
      onFocus={(event: React.FocusEvent<HTMLButtonElement>) => { preloadQuietly(); onFocus?.(event) }}
      onTouchStart={(event: React.TouchEvent<HTMLButtonElement>) => { preloadQuietly(); onTouchStart?.(event) }}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) root.change(!root.open)
      }}
      {...props}
    />
  )
}

function DialogClose({
  asChild = false,
  onClick,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const root = useDialogRoot()
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="dialog-close"
      type={asChild ? undefined : "button"}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (!event.defaultPrevented) root.change(false)
      }}
      {...props}
    />
  )
}

/** Stands where the box will be while the popup is fetched: the scrim, which takes no press. */
function LoadingScrim({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      data-slot="dialog-loading"
      className={cn("pointer-events-none fixed inset-0 z-50 bg-[var(--scrim)] motion-safe:animate-overlay-in", className)}
    />
  )
}

/** Closes the dialog, and forgets the failed load, when the popup module cannot be fetched (a stale chunk after a deploy). */
class LoadBoundary extends React.Component<{ onFail: () => void; children?: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onFail()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

function PopupHost(props: DialogPopupProps) {
  const module = popup ?? React.use(preloadDialogPopup())
  return <module.default {...props} />
}

type DialogContentProps = Omit<DialogPopupProps, "open" | "onOpenChange" | "children"> & {
  children?: React.ReactNode
  showCloseButton?: boolean
  /** `none` for a dialog that draws its own surface (the lightbox, a palette). */
  material?: "overlay" | "none"
}

/** The ids the popup names itself and is described by: the title and description that are mounted, unless the caller
 *  named the dialog itself. An `aria-describedby` that is present and undefined opts out of the description, as it
 *  did in Radix. */
function useDialogNames(props: Pick<DialogContentProps, "aria-label" | "aria-labelledby" | "aria-describedby">, root: DialogRoot) {
  const described = "aria-describedby" in props ? props["aria-describedby"] : root.hasDescription ? root.descriptionId : undefined
  const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined
  const labelled = named || !root.hasTitle ? props["aria-labelledby"] : root.titleId
  return { "aria-describedby": described, "aria-labelledby": labelled }
}

/** Whether the popup's chunk failed to load for this open. A fresh open clears it. */
function useLoadFailure(open: boolean) {
  const [failed, setFailed] = React.useState(false)
  // Cleared while rendering, so it lands before the attempt it allows and cannot clear the failure of that attempt.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setFailed(false)
  }
  return [failed, setFailed] as const
}

const CONTENT_CLASS =
  "absolute top-1/2 left-1/2 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--radius-xl)] p-6 sm:max-w-lg"

function DialogContent({
  className,
  children,
  showCloseButton = true,
  material = "overlay",
  overlayClassName,
  id,
  ...props
}: DialogContentProps) {
  const root = useDialogRoot()
  const [failed, setFailed] = useLoadFailure(root.open)
  const names = useDialogNames(props, root)
  if (!root.hasOpened || failed) return null
  return (
    <LoadBoundary
      onFail={() => {
        setFailed(true)
        root.change(false)
      }}
    >
      <React.Suspense fallback={root.open ? <LoadingScrim className={overlayClassName} /> : null}>
        <PopupHost
          data-slot="dialog-content"
          open={root.open}
          onOpenChange={root.change}
          overlayClassName={overlayClassName}
          id={id ?? root.contentId}
          className={cn(CONTENT_CLASS, material === "overlay" && "glass-overlay", className)}
          {...props}
          {...names}
        >
          {children}
          {showCloseButton && <DialogCloseButton />}
        </PopupHost>
      </React.Suspense>
    </LoadBoundary>
  )
}

/** The corner X. Last in the box, so the first control of the content is the first in the tab order. */
function DialogCloseButton() {
  return (
    <DialogClose className="focus-outline absolute top-4 right-4 grid size-8 place-items-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0">
      <XIcon size={16} aria-hidden />
      <span className="sr-only">Close</span>
    </DialogClose>
  )
}

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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
}
