import { scheduleMenuWarmup } from "./menu-warmup"

/* The loader of `dialog-popup.tsx`, the React Aria half of the dialogs (see `dialog.tsx`). */

let warmupScheduled = false

/** Asks, once per page, for the popup to be fetched when the page is idle (production builds only). */
export function warmPopupOnce() {
  if (warmupScheduled || !import.meta.env.PROD || typeof window === "undefined") return
  warmupScheduled = true
  scheduleMenuWarmup(() => void preloadDialogPopup().catch(() => {}), { document, window })
}

/** The popup module, loaded once. A load that failed stays failed for whoever is rendering from it (a render that
 *  started a new fetch each time would suspend forever on a chunk that cannot come), until a fresh request asks
 *  again (`retryFailedLoad`): the next open, or a trigger's pointer. */
export type PopupModule = typeof import("./dialog-popup")
let popup: PopupModule | null = null
let loading: Promise<PopupModule> | null = null
let failed = false

export function preloadDialogPopup(): Promise<PopupModule> {
  loading ??= import("./dialog-popup").then(
    (module) => {
      failed = false
      return (popup = module)
    },
    (error) => {
      failed = true
      throw error
    },
  )
  return loading
}

/** Forgets a failed load, so the fetch is tried again by whatever asks next. */
export function retryFailedLoad() {
  if (failed) {
    failed = false
    loading = null
  }
}

/** The popup if it has loaded, else a promise to suspend on. */
export function loadedPopup(): PopupModule | Promise<PopupModule> {
  return popup ?? preloadDialogPopup()
}

/** Starts the fetch from a trigger's pointer, focus or touch; a failed one is reported to whoever opens the dialog. */
export const preloadQuietly = () => {
  retryFailedLoad()
  void preloadDialogPopup().catch(() => {})
}
