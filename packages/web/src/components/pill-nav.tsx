import { type ComponentType, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect } from "react"
import { Link, useLocation } from "react-router-dom"
import { PanelLeft } from "@/components/ui/icon"
import { useSettings } from "@/routes/settings-provider"
import { useNavigation } from "@/lib/use-navigation"
import { isNavLinkActive, openTodosFromLink, useNavSurface } from "@/components/nav-surface"
import { useOpenTodosTab } from "@/components/chat/file-open-context"
import { cn } from "@/lib/utils"
import { useFeatures } from "@/hooks/use-features"
import { prefetchRoute } from "@/lib/route-prefetch"
import { PRODUCT_NAME } from "@/lib/brand"
import { PortalMark } from "@/components/brand-mark"

// ---------------------------------------------------------------------------
// Frosted pill primitives (mockup _shared.css `.pill` recipe)
// ---------------------------------------------------------------------------
// Glass material (.glass-tint, glass-identity.css): the float tint, lit edge and
// specular highlight, full radius, flipping with the theme. These pills sit on
// the chat's top scrim, which is the surface that blurs the scrolling thread
// behind them, so they are tint only: blur does not nest. Coarse pointers and
// reduced transparency get the same material composited to alpha 1.
const PILL_MATERIAL = "glass-tint border-[0.5px] border-[var(--pill-border)]"

// The cross-page pill system and the chat header pills share this primitive; the
// nav popover reuses the EXACT same material, only the radius differs.
export const PILL_CLASS = `pointer-events-auto inline-flex items-center gap-0.5 rounded-full p-1 ${PILL_MATERIAL}`

export function PillButton({
  onClick,
  title,
  ariaLabel,
  ariaExpanded,
  className,
  children,
}: {
  onClick?: () => void
  title?: string
  ariaLabel?: string
  ariaExpanded?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={cn(
        // Mobile controls keep a 44px target; desktop retains its compact chrome.
        "inline-flex size-11 lg:size-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "text-[var(--text-secondary)]",
        "hover:bg-[var(--fill-secondary)] hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Nav primitives — shared by the popover (non-chat pages) AND the chat route's
// in-surface list⇄nav swap, so the nav links read identically everywhere.
// ---------------------------------------------------------------------------

export { isNavItemActive } from "@/components/nav-surface"

// ---------------------------------------------------------------------------
// NavRibbon — the chat route's permanent slim icon rail (~56px). Always mounted
// (desktop only). Icons-only at rest; the rail NEVER widens, so the chat list is
// never covered. Hovering/focusing a single icon springs ONLY that icon's label
// out as a small frosted pill to its right — a per-key "piano" reveal — while the
// icon itself lifts a touch (Dock-style). The top slot shows the Jinn logo at
// rest and cross-fades to the sidebar toggle on hover (ChatGPT-style). Active
// item = soft --fill-secondary, NEVER --accent.
// ---------------------------------------------------------------------------

// The floating label that springs out beside a hovered/focused icon. It is the
// rail's tooltip, drawn with no script at all (the rail is in the always-loaded
// shell, where a positioned React Aria tooltip would not fit the initial
// budget): CSS hover and focus-within show it, `.rail-reveal` gives it the
// overlay glass (glass-identity.css), blurred only while it shows so one label
// is one blurred surface, and Escape hides it (see `useDismissLabelOnEscape`).
// The icon carries the real aria-label, so the pill is decorative (aria-hidden).
// Under reduced motion it fades only (no slide).
const RIBBON_LABEL_PILL =
  "rail-reveal whitespace-nowrap rounded-full " +
  "px-2.5 py-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] " +
  "opacity-0 transition-[opacity,transform] duration-150 [transition-timing-function:var(--ease-snappy)] " +
  "motion-safe:-translate-x-1.5 group-hover/row:opacity-100 group-hover/row:translate-x-0 " +
  "group-focus-within/row:opacity-100 group-focus-within/row:translate-x-0 motion-reduce:transition-opacity"

/** A label that covers what the reader is looking at has to be dismissible
 *  without moving the pointer or the focus, so Escape hides the label of the
 *  row under the pointer or holding focus, and it comes back the next time the
 *  pointer or focus enters a row (so a row focused after its pointer-dismissed
 *  label shows its label again). Done on the element, not in state: nothing
 *  re-renders for it. */
function useDismissLabelOnEscape() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      for (const row of document.querySelectorAll<HTMLElement>("[data-rail-row]:is(:hover, :focus-within)")) {
        row.dataset.labelDismissed = ""
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}

const restoreLabel = (event: { currentTarget: HTMLElement }) => {
  delete event.currentTarget.dataset.labelDismissed
}

/** One ribbon entry — a fixed 44px icon square. It never resizes; the label is a
 *  floating pill that escapes to the right on hover/focus (the piano reveal), and
 *  the icon lifts/scales a touch like a pressed Dock key. */
function RibbonRow({
  Icon,
  label,
  isActive,
  href,
  to = href,
  onClick,
}: {
  Icon: ComponentType<{ size?: number | string; className?: string }>
  label: string
  isActive?: boolean
  /** The route the row stands for: what is prefetched. */
  href?: string
  /** Where the link goes, when that is not the route itself (the Todos tab opens through the chat route). */
  to?: string
  // Receives the click event so a link row can preventDefault a no-op
  // same-route navigation (used by the Chat icon to reveal the list instead).
  onClick?: (e: ReactMouseEvent) => void
}) {
  const cls = cn(
    "group/row relative flex size-11 shrink-0 items-center justify-center rounded-[12px] transition-colors duration-150 [transition-timing-function:var(--ease-smooth)]",
    isActive
      ? "bg-[var(--fill-secondary)] text-[var(--text-primary)]"
      : "text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
  )
  const inner = (
    <>
      <span className="flex items-center justify-center transition-transform duration-150 [transition-timing-function:var(--ease-snappy)] motion-safe:group-hover/row:-translate-y-px motion-safe:group-hover/row:scale-110 motion-safe:group-active/row:scale-95 motion-reduce:transform-none">
        <Icon size={20} className="shrink-0" />
      </span>
      {/* Piano reveal — floats past the rail edge; flex-centers vertically so the
          inner pill is free to animate on the X axis. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-full z-50 ml-2 flex items-center">
        <span className={RIBBON_LABEL_PILL}>{label}</span>
      </span>
    </>
  )
  if (href) {
    return (
      <Link
        to={to ?? href} viewTransition
        data-rail-row=""
        onClick={onClick}
        onPointerEnter={(event) => { restoreLabel(event); prefetchRoute(href) }}
        onFocus={(event) => { restoreLabel(event); prefetchRoute(href) }}
        onBlur={restoreLabel}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        className={cls}
      >
        {inner}
      </Link>
    )
  }
  return (
    <button type="button" data-rail-row="" onClick={onClick} onPointerEnter={restoreLabel} onFocus={restoreLabel} onBlur={restoreLabel} aria-label={label} className={cls}>
      {inner}
    </button>
  )
}

/** The slim icon nav rail. On the chat route `listOpen` + `onToggleList` drive
 *  the chat-list fold (top slot = logo↔toggle morph). Mounted globally elsewhere
 *  with NEITHER prop — then the top slot is a brand mark linking home, with no
 *  fold/toggle (there is no list to fold). */
export function NavRibbon({
  listOpen = false,
  onToggleList,
}: {
  listOpen?: boolean
  onToggleList?: () => void
}) {
  const { data: features } = useFeatures()
  const navItems = useNavigation(features?.notesEnabled === true).items
  const pathname = useLocation().pathname
  const surface = useNavSurface()
  const openTodosTab = useOpenTodosTab()
  const { settings } = useSettings()
  useDismissLabelOnEscape()
  const portalName = settings.portalName ?? PRODUCT_NAME
  // The Chat icon is OPEN-ONLY. While already on the chat route ("/") with the
  // list collapsed, a plain click reveals the list instead of firing a dead
  // same-route navigation. Not on "/" → the Link navigates as before; list
  // already open → harmless no-op. Modified clicks (new tab/window) fall through
  // to the Link untouched. Closing the list stays the top toggle's job, so one
  // control never means both open and close.
  const onChatIconClick = (e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (onToggleList && pathname === "/" && !listOpen) {
      e.preventDefault()
      onToggleList()
    }
  }
  return (
    // The placeholder reserves the rail width (w-14 = 56px) in the flex row; the
    // real rail floats above it so the per-icon label pills can escape to the
    // right (over the list / thread) without widening the rail or reflowing it.
    <div className="relative hidden h-full w-14 shrink-0 lg:block">
      {/* Named so a route change snapshots the rail apart from the page — globals.css. */}
      <nav aria-label="Primary"
        className="absolute inset-y-0 left-0 z-30 flex w-14 flex-col items-center gap-0.5 px-1.5 pb-2.5 pt-3.5 [view-transition-name:jinn-nav-rail]"
      >
        {/* Top slot — a plain, button-sized Jinn brand mark that fills the rail
            top (no frosted-pill chrome). It morphs to the sidebar.left toggle
            while the pointer is anywhere over the LEFT region — the rail AND the
            chat-list column (ChatGPT-style, via group/sidebar on the region
            wrapper in chat/page.tsx) — or while the button is focused after a
            click; it reverts to the logo on mouse-leave. The thread/main content
            sits outside that group, so hovering it never triggers the morph.
            pt-3.5 centers the 44px button on the same y (~36px) as the thread's
            right actions pill, so rail-top and header read as one row. */}
        <div className="group/logo mb-1">
          {onToggleList ? (
            <button
              type="button"
              onClick={onToggleList}
              title={listOpen ? "Hide chats" : "Show chats"}
              aria-label={listOpen ? "Hide chats" : "Show chats"}
              aria-expanded={listOpen}
              className="relative flex size-11 items-center justify-center rounded-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
            >
              {/* The glass mark, or the operator's own glyph. A glyph gets
                  full-strength brand color (NOT the button's --text-secondary)
                  and forced color-emoji presentation, so a custom monochrome or
                  letter mark reads crisp at rest in BOTH themes. */}
              <span
                aria-hidden
                className="absolute inset-0 flex items-center justify-center text-[26px] leading-none text-[var(--text-primary)] [font-variant-emoji:emoji] transition-opacity duration-150 group-hover/sidebar:opacity-0 group-focus-within/logo:opacity-0"
              >
                <PortalMark size={32} />
              </span>
              <PanelLeft
                size={22}
                className="opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100 group-focus-within/logo:opacity-100"
              />
            </button>
          ) : (
            // Global (non-chat) rail: no list to fold, so the top slot is a plain
            // brand mark that links home. Same mark as the chat variant — no
            // toggle/morph.
            <Link
              to="/" viewTransition
              onPointerEnter={() => prefetchRoute("/")}
              onFocus={() => prefetchRoute("/")}
              aria-label={portalName}
              title={portalName}
              className="relative flex size-11 items-center justify-center rounded-[12px] transition-colors hover:bg-[var(--fill-secondary)]"
            >
              <span
                aria-hidden
                className="flex items-center justify-center text-[26px] leading-none text-[var(--text-primary)] [font-variant-emoji:emoji]"
              >
                <PortalMark size={32} />
              </span>
            </Link>
          )}
        </div>

        {/* Nav icons — per-icon piano reveal. */}
        {navItems.map((item) => (
          <RibbonRow
            key={item.href}
            Icon={item.icon}
            label={item.label}
            href={item.href}
            to={item.to}
            isActive={isNavLinkActive(item.href, pathname, surface)}
            onClick={item.href === "/" ? onChatIconClick : item.to ? (event) => openTodosFromLink(event, openTodosTab) : undefined}
          />
        ))}
      </nav>
    </div>
  )
}
