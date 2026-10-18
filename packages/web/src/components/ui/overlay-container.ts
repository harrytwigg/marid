import * as React from "react"

/**
 * Where a React Aria overlay portals to when it is opened inside something that
 * traps focus and blocks the page behind it (a Radix dialog does both: it hands
 * focus that leaves its content back, and sets `pointer-events: none` on the
 * body, which a surface portalled to the body inherits). `null` is the body,
 * React Aria's own default. A dialog provides its content element here until
 * the dialogs move to React Aria, which nest their overlays on their own.
 */
export const OverlayContainerContext = React.createContext<Element | null>(null)
