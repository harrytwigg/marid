/**
 * The row above the transcript that reports on the older page.
 *
 * It is rendered whether or not it has anything to say. A spinner appearing
 * above a windowed transcript drops everything below it by its own height and
 * lifts it back when the page lands — twice, under a reader who only scrolled —
 * and the anchoring below it works in the virtualizer's offsets, which know
 * nothing about a row outside the virtual block. Reserving the height costs one
 * empty line at the very top and no scroll writes at all.
 */
export function OlderPageRow({ loading, error }: { loading: boolean; error: Error | null }) {
  return (
    <div className="flex h-8 items-center justify-center">
      {loading && (
        <span role="status" aria-label="Loading older messages" className="size-3 rounded-full bg-[var(--fill-tertiary)] animate-[hundredfold-pulse_1.4s_infinite]" />
      )}
      {!loading && error && (
        <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          Older messages could not load
        </span>
      )}
    </div>
  )
}
