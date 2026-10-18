/** How long, in frames, focus is waited for when a closed menu's surface is still on its way out. */
const MAX_WAIT_FRAMES = 40

/**
 * Puts focus back on the trigger once a menu has closed, unless focus has gone somewhere deliberate (a press on
 * another control, an item that focused a field). React Aria restores focus itself, but not when something else got
 * there first: a Radix dialog moves focus that leaves its content to the content, and then neither is "the body".
 *
 * The surface is still in the page while it animates out, and focus stays inside it. A dialog pulls focus to itself
 * only once the surface has gone, so this keeps looking until focus is on the body or on an ancestor of the trigger
 * (the dialog), or is anywhere else that is not the exiting surface.
 */
export function returnFocusTo(trigger: HTMLElement | null) {
  let frames = 0
  const look = () => {
    if (!trigger?.isConnected) return
    const active = document.activeElement
    const adrift = !active || active === document.body || (active !== trigger && active.contains(trigger))
    if (adrift) {
      trigger.focus({ preventScroll: true })
      return
    }
    const leaving = Boolean(active.closest("[data-menu-surface]"))
    if (leaving && frames++ < MAX_WAIT_FRAMES) requestAnimationFrame(look)
  }
  requestAnimationFrame(look)
}
