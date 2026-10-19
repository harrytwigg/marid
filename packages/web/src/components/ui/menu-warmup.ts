/**
 * Warms the menu popup (and the React Aria chunks it shares) once the page has loaded and gone idle, so a first tap
 * on a phone, which has no hover to start the fetch, finds it already there. It runs once per page, after `load`,
 * so the initial path is untouched; production builds only (a dev server or a test would load it for nothing).
 */
const IDLE_TIMEOUT_MS = 4000

export function scheduleMenuWarmup(
  warm: () => void,
  env: { document: Pick<Document, "readyState">; window: Pick<Window, "addEventListener" | "setTimeout"> & { requestIdleCallback?: Window["requestIdleCallback"] } },
) {
  const whenIdle = () => {
    if (env.window.requestIdleCallback) env.window.requestIdleCallback(warm, { timeout: IDLE_TIMEOUT_MS })
    else env.window.setTimeout(warm, IDLE_TIMEOUT_MS / 2)
  }
  if (env.document.readyState === "complete") whenIdle()
  else env.window.addEventListener("load", whenIdle, { once: true })
}
