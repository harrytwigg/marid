import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useShellChrome } from "./page-scaffold"

const LARGE_TITLE_CLASS =
  "font-[family-name:var(--font-ui)] text-[length:var(--text-large-title)] font-[var(--weight-bold)] leading-[var(--text-large-title--line-height)] tracking-[var(--text-large-title--letter-spacing)] text-[var(--text-primary)]"

const INLINE_TITLE_CLASS =
  "font-[family-name:var(--font-ui)] text-[length:var(--text-headline)] font-[var(--weight-semibold)] leading-[var(--text-headline--line-height)] text-[var(--text-primary)]"

// The gap between a header and the content under it, owned here so every page
// that scrolls its header (the collapsing title) spaces its body the same way.
// The subtitle carries it; with no subtitle a spacer does. Never the title: the
// large title is display:none under reduced motion and without scroll timelines,
// and a hidden box takes its margin with it.
const HEADER_GAP_CLASS = "mb-[22px]"

function LargeTitle({ title }: { title: ReactNode }) {
  return (
    <div className={cn("jinn-large-title", LARGE_TITLE_CLASS)}>
      {typeof title === "string" ? <h1>{title}</h1> : title}
    </div>
  )
}

function Subtitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]", className)}>
      {children}
    </div>
  )
}

/** The chrome the large title collapses into: page-wide material, the inline
 *  title, and whatever the route puts on the trailing side. */
function TitleBar({ title, trailing }: { title: ReactNode; trailing: ReactNode }) {
  return (
    <div
      data-slot="large-title-bar"
      className="jinn-title-bar sticky z-20 grid min-h-11 grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 bg-[var(--material-thick)] backdrop-blur"
    >
      {/* Three columns, and which of the two outer ones gives way decides where
          the title sits. While the title fits, both `1fr` tracks take an equal
          share and it is centred on the bar. Once it is long enough to eat the
          free space, the empty leading track collapses first — `1fr` floors a
          track at its own min-content, and an empty one's is 0 while the trailing
          one's is its buttons — so the title shifts left (39px at 390px on a bar
          carrying a 78px trailing control) and truncates against them rather than
          running underneath. Holding the centre through that would mean the
          trailing width on the leading side: JS measurement, or a mirrored copy
          of the buttons. Neither is worth those 39px. The bar is a constant 44px,
          so one line is all the title gets either way.
          `aria-hidden` because the real <h1> is still in the scroll flow above:
          announced, this copy would give the page a second heading. */}
      <div aria-hidden="true" className={cn("jinn-inline-title pointer-events-none col-start-2 truncate text-center lg:hidden", INLINE_TITLE_CLASS)}>
        {typeof title === "string" ? title : null}
      </div>
      <div className="relative col-start-3 flex items-center gap-2 justify-self-end">{trailing}</div>
    </div>
  )
}

export function LargeTitleHeader({
  title,
  subtitle,
  trailing,
  leading,
  bodyGap = true,
}: {
  title: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  leading?: ReactNode
  /** Space the body below the header. Detail pages that already lay out their
   *  own first section turn it off rather than stack two gaps. */
  bodyGap?: boolean
}) {
  const chrome = useShellChrome()
  const trailingSlot = (
    <>
      {trailing}
      {chrome.trailingAction}
    </>
  )
  if (!chrome.collapse) {
    return (
      <header data-slot="large-title-header" className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {leading}
          <LargeTitle title={title} />
          {subtitle ? <Subtitle>{subtitle}</Subtitle> : null}
        </div>
        {trailingSlot}
      </header>
    )
  }

  const gapClass = bodyGap ? HEADER_GAP_CLASS : undefined

  return (
    // `display: contents` so the bar's containing block is the scrollport rather
    // than this header. A sticky box cannot leave the block it lives in, and this
    // block ends just under the subtitle — which is exactly where the bar used to
    // scroll away instead of taking over.
    <header data-slot="large-title-header" className="contents">
      <TitleBar title={title} trailing={trailingSlot} />
      {leading}
      <LargeTitle title={title} />
      {subtitle ? <Subtitle className={gapClass}>{subtitle}</Subtitle> : bodyGap ? <div aria-hidden data-slot="large-title-gap" className="h-[22px]" /> : null}
    </header>
  )
}
