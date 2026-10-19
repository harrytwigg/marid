import React from "react"
import { TriangleAlert } from "@/components/ui/icon"

/** `chip` is an inline bar item; `pane` is a block that owns its slot. */
export type ContribBoundaryVariant = "chip" | "pane"

interface ContribBoundaryProps {
  children: React.ReactNode
  /** Contribution id — named in the fallback, and tagged onto the console error. */
  id: string
  variant?: ContribBoundaryVariant
}

/**
 * The wall between one contribution's render and everything around it. A
 * contribution that throws degrades to a Retry inside its own slot; its
 * siblings, the surface hosting them, and the app keep working.
 *
 * Retry clears the error and mounts the contribution again, so a failure that
 * has since gone away (a fetch that succeeds the second time, a plugin
 * reloaded from disk) recovers without a page reload.
 */
export class ContribBoundary extends React.Component<ContribBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[contrib:${this.props.id}]`, error.message, "\nComponent stack:", info.componentStack)
  }

  private readonly retry = () => this.setState({ error: null })

  override render() {
    const { error } = this.state
    if (!error) return this.props.children

    const { id, variant = "pane" } = this.props
    if (variant === "chip") {
      // A bar has no room for a message, so the id is the visible half and the
      // reason rides in the tooltip. The whole chip is the retry affordance.
      return (
        <button
          type="button"
          onClick={this.retry}
          aria-label={`Retry ${id}`}
          title={`${id}: ${error.message}`}
          className="inline-flex h-[34px] shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 text-[length:var(--text-caption2)] text-[var(--system-red)] transition-colors hover:bg-[var(--fill-secondary)]"
        >
          <TriangleAlert size={12} aria-hidden />
          {id}
        </button>
      )
    }

    return (
      <div className="flex flex-col items-start gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] p-4">
        <p className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--system-red)]">
          {id} failed to render
        </p>
        <p className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{error.message}</p>
        <button
          type="button"
          onClick={this.retry}
          className="rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-3 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] transition-colors hover:bg-[var(--fill-tertiary)]"
        >
          Retry
        </button>
      </div>
    )
  }
}
