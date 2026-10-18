import { scheduleMenuWarmup } from "./menu-warmup"

/* The loader of `dialog-popup.tsx`, the React Aria half of the dialogs (see `dialog.tsx`). */

let warmupScheduled = false

/** Asks, once per page, for the popup to be fetched when the page is idle (production builds only). */
export function warmPopupOnce() {
  if (warmupScheduled || !import.meta.env.PROD || typeof window === "undefined") return
  warmupScheduled = true
  scheduleMenuWarmup(() => void preloadDialogPopup().catch(() => {}), { document, window })
}

/** The popup module, loaded once. A failed load is forgotten, so the next open tries again. */
export type PopupModule = typeof import("./dialog-popup")
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

/** The popup if it has loaded, else a promise to suspend on. */
export function loadedPopup(): PopupModule | Promise<PopupModule> {
  return popup ?? preloadDialogPopup()
}

/** Starts the fetch from a trigger's pointer, focus or touch; a failed one is reported to whoever opens the dialog. */
export const preloadQuietly = () => void preloadDialogPopup().catch(() => {})
