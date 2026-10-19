import { Link } from "react-router-dom"
import { ChevronRight, Puzzle } from "@/components/ui/icon"
import { Section } from "../shared"

/** The Settings row that opens the plugins page. It is a link rather than an
 *  inline section because the list has its own header, refresh and empty state,
 *  and folding all of that into the settings form would drown it. */
export function PluginsEntry() {
  return (
    <Section title="Plugins">
      <Link
        to="/settings/plugins"
        className="-mx-1 flex min-h-[44px] items-center gap-3 rounded-[10px] px-1 transition-colors hover:bg-[var(--fill-quaternary)]"
      >
        <span
          className="grid size-[28px] flex-none place-items-center rounded-[8px]"
          style={{ background: "var(--accent-fill)", color: "var(--accent)" }}
        >
          <Puzzle size={15} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">Installed plugins</span>
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            Enable, disable and inspect what this workspace runs
          </span>
        </span>
        <ChevronRight size={14} className="flex-none text-[var(--text-quaternary)]" aria-hidden />
      </Link>
    </Section>
  )
}
