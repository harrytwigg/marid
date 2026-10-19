import { Check, Loader2, TriangleAlert } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import type { ConfigSaveState } from "./use-config-commit"

/**
 * Whether the last edit reached config.yaml. It floats over the page rather than
 * sitting at the end of it: Settings runs several screens long, and a refused save
 * used to be announced above the fold while the operator was editing below it.
 */
export function ConfigSaveStatus({ state }: { state: ConfigSaveState }) {
  if (state.phase === "idle") return null
  const failed = state.phase === "failed"

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed right-[var(--space-4)] bottom-[calc(var(--tab-bar-height)+max(var(--safe-bottom),6px))] z-40",
        "flex max-w-[min(24rem,calc(100vw-2*var(--space-4)))] items-center gap-2 rounded-2xl px-3 py-2",
        "text-[length:var(--text-footnote)] font-[var(--weight-medium)] shadow-[var(--shadow-card)]",
        "lg:right-[var(--space-5)] lg:bottom-[var(--space-5)]",
      )}
      style={{
        background: failed
          ? "color-mix(in srgb, var(--system-red) 12%, var(--bg-secondary))"
          : "var(--bg-secondary)",
        color: failed ? "var(--system-red)" : "var(--text-secondary)",
      }}
    >
      {state.phase === "saving" && <Loader2 size={14} className="shrink-0 animate-spin" />}
      {state.phase === "saved" && (
        <Check size={14} className="shrink-0" color="var(--system-green)" />
      )}
      {failed && <TriangleAlert size={14} className="mt-[1px] shrink-0 self-start" />}
      <span>
        {state.phase === "saving" ? "Saving…" : state.phase === "saved" ? "Saved" : state.message}
      </span>
    </div>
  )
}
