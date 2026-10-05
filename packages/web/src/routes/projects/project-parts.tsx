import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/* The small pieces every section of a project card shares. */

export const FIELD_CLASS =
  "apple-input min-h-10 w-full min-w-0 text-[length:var(--text-footnote)] text-[var(--text-primary)]"

export const ACTION_CLASS =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] px-4 " +
  "text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] " +
  "transition-opacity disabled:opacity-50"

export const QUIET_ACTION_CLASS =
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 " +
  "text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] " +
  "transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"

/** One titled block inside a project card. */
export function ProjectSection({
  title,
  hint,
  children,
  className,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section aria-label={title} className={cn("grid gap-2 border-t-[0.5px] border-[var(--separator)] pt-4", className)}>
      <div>
        <h3 className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] uppercase tracking-[0.04em] text-[var(--text-tertiary)]">
          {title}
        </h3>
        {hint ? <p className="mt-0.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-lg)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
    >
      {message}
    </div>
  )
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
