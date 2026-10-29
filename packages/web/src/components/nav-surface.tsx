import { createContext, useContext, type ReactNode } from "react"

/**
 * What the chat route is showing, for the navigation drawn around it: the route is "/" for a chat and
 * for the Todos tab alike, so the path cannot say which nav item is current. The chat page provides
 * it; every other page leaves it null and the path decides.
 */
export type NavSurface = "chat" | "todos"

/** The single active-route rule used across the nav rail and the mobile tab bar. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href)
}

/** The same rule with what the chat route shows: the route is "/" for a chat and for the Todos tab, so there
 *  Todos is current while its tab is the focused one, and Chat is current otherwise. */
export function isNavLinkActive(href: string, pathname: string, surface: NavSurface | null): boolean {
  if (surface && pathname === "/") {
    if (href === "/todos") return surface === "todos"
    if (href === "/") return surface === "chat"
  }
  return isNavItemActive(href, pathname)
}

const NavSurfaceContext = createContext<NavSurface | null>(null)

export function NavSurfaceProvider({ surface, children }: { surface: NavSurface; children: ReactNode }) {
  return <NavSurfaceContext.Provider value={surface}>{children}</NavSurfaceContext.Provider>
}

export function useNavSurface(): NavSurface | null {
  return useContext(NavSurfaceContext)
}

/**
 * A click on a link to the Todos tab, taken by the chat page when it can: the tab opens in place, with no
 * navigation to the route the page is already on. A modified click (a new browser tab) and a page with no
 * chat layout around the link are left to the link itself.
 */
export function openTodosFromLink(
  event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void },
  open: (() => void) | null,
): void {
  if (!open || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  open()
}
