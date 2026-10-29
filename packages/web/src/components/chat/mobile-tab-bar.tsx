import { Link, useLocation } from "react-router-dom"
import { isNavItemActive, isNavLinkActive, openTodosFromLink, useNavSurface, type NavSurface } from "@/components/nav-surface"
import { useOpenTodosTab } from "@/components/chat/file-open-context"
import { MORE_NAV_ITEM } from "@/lib/nav"
import { useNavigation } from "@/lib/use-navigation"
import { cn } from "@/lib/utils"
import { useFeatures } from "@/hooks/use-features"

// ---------------------------------------------------------------------------
// MobileTabBar — GRS-022. The SOLE mobile nav: an icon-only iOS-style bottom tab
// bar carrying the 4 primary destinations (Chat · Todos · Notes · More).
// Mobile only (lg:hidden); the parent decides when to mount it. --material-thick
// over content with the single 0.5px top hairline iOS tab bars are allowed (the
// one sanctioned exception to "no hairlines at rest"). Frosted on pointer:fine;
// coarse pointers get the same material composited to alpha 1
// (--material-thick-opaque) instead, so the backdrop filter stops re-rasterising
// over the scrolling thread.
//
// Icons-only (HIG icons-over-labels): the glyphs are self-explanatory, so the
// bar carries no text. The "you are here" cue is the active tab's --accent tint
// (the sanctioned exception to the desktop rail's "never --accent" rule, scoped
// to THIS component only — the desktop NavRibbon is untouched). Every tab keeps
// an aria-label (no visible text ≠ no accessible name) and a ≥49px tap target so
// a label-free bar stays fully accessible and thumb-friendly.
//
// The More tab stays lit while the operator is on any of its overflow children
// (Org/Cron/Skills/Activity/Limits/Settings), so the bar always shows where you
// are even after a one-tap dive out of the overflow list.
// ---------------------------------------------------------------------------

function isTabActive(href: string, pathname: string, overflowHrefs: string[], surface: NavSurface | null): boolean {
  if (href === MORE_NAV_ITEM.href) {
    return (
      pathname === MORE_NAV_ITEM.href ||
      overflowHrefs.some((h) => isNavItemActive(h, pathname))
    )
  }
  return isNavLinkActive(href, pathname, surface)
}

export function MobileTabBar() {
  const pathname = useLocation().pathname
  const surface = useNavSurface()
  const openTodosTab = useOpenTodosTab()
  const { data: features } = useFeatures()
  const navigation = useNavigation(features?.notesEnabled === true)

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 lg:hidden",
        "flex items-stretch",
        // Named so a route change snapshots the bar on its own rather than
        // cross-fading the one surface that is on both sides of every tap.
        "[view-transition-name:jinn-tab-bar]",
        // Floating glass: blurs the page that scrolls beneath it on a fine
        // pointer; a coarse pointer gets the same tint opaque.
        "glass-float-bar border-t-[0.5px]",
        "py-1.5 pb-[max(var(--safe-bottom),6px)]",
      )}
    >
      {navigation.mobileItems.map((item) => {
        const isActive = isTabActive(item.href, pathname, navigation.overflowHrefs, surface)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            to={item.to ?? item.href}
            viewTransition
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            onClick={(event) => {
              if (item.to) openTodosFromLink(event, openTodosTab)
              // HIG tab re-tap: tapping the already-active Chat tab scrolls the
              // chat list back to the top (the route is unchanged, so the Link is
              // otherwise a no-op). GRS-023.
              if (isActive && item.href === "/") {
                document
                  .querySelector<HTMLElement>("[data-chat-list-scroll]")
                  ?.scrollTo({ top: 0, behavior: "smooth" })
              }
            }}
            className={cn(
              // min-w-0 so flex-1 can shrink past the tap pill's own 3.5rem: at a
              // large browser text size four rem-wide pills outrun a phone
              // viewport and the last tab lands off-screen.
              "min-h-[49px] min-w-0 flex-1 flex items-center justify-center",
              "transition-colors",
              isActive
                ? "text-[var(--accent)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
            )}
          >
            <span className="flex h-9 w-14 max-w-full items-center justify-center rounded-full">
              <Icon size={25} className="shrink-0" />
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
