import { useRef } from "react"
import { Search } from "lucide-react"

/** The Todos search box is an entry point to the one global overlay, not a
 *  second search implementation. A button cannot drop the first keystroke the
 *  way an input handing its value onward can, so a printable key opens the
 *  overlay already seeded with that character. */
export function SearchLauncher({
  className,
  iconSize,
  labelClassName,
  onOpen,
}: {
  className: string
  iconSize: number
  labelClassName: string
  onOpen: (seed?: string) => void
}) {
  // The overlay is loaded lazily, so a few hundred milliseconds can pass before
  // it mounts and takes focus, and every key struck in that window still lands
  // here. Seeding with the newest key alone would throw the rest of the burst
  // away, so the whole burst accumulates until focus actually leaves.
  const burst = useRef("")

  return (
    <button
      type="button"
      aria-label="Search todos"
      data-testid="filter-search"
      onClick={() => {
        burst.current = ""
        onOpen()
      }}
      onBlur={() => { burst.current = "" }}
      onKeyDown={(e) => {
        // Enter and Space stay the button's own activation keys.
        if (e.key.length !== 1 || e.key === " " || e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        burst.current += e.key
        onOpen(burst.current)
      }}
      className={`focus-outline outline-none transition-colors hover:bg-[var(--fill-secondary)] ${className}`}
    >
      <Search size={iconSize} strokeWidth={2} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
      <span className={labelClassName}>Search todos</span>
    </button>
  )
}
