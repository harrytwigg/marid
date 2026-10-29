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
const ShowChatContext = createContext<(() => boolean) | null>(null)

/** `onShowChat` leaves the Todos tab for a chat (the phone's chat list, a chat of the layout on the desktop);
 *  it says whether it did, and a link it did not handle goes where it points. */
export function NavSurfaceProvider({ surface, onShowChat, children }: { surface: NavSurface; onShowChat: () => boolean; children: ReactNode }) {
  return (
    <NavSurfaceContext.Provider value={surface}>
      <ShowChatContext.Provider value={onShowChat}>{children}</ShowChatContext.Provider>
    </NavSurfaceContext.Provider>
  )
}

export function useNavSurface(): NavSurface | null {
  return useContext(NavSurfaceContext)
}

/**
 * A click on the nav's Chat link while the Todos tab is in front, taken by the chat page when it can: the
 * route is already "/", so following the link would change nothing the reader can see. A modified click
 * (a new browser tab) is left to the link.
 */
export function useShowChatFromLink(): (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }) => void {
  const surface = useContext(NavSurfaceContext)
  const showChat = useContext(ShowChatContext)
  return (event) => {
    if (surface !== "todos" || !showChat || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (showChat()) event.preventDefault()
  }
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
