/* design-cron §2 — the shape of a grouped-inset job list before it arrives:
 * an employee header and three rows at the row geometry, pulsing on a stagger
 * so the wait reads as loading rather than as an empty company. */

export function ListSkeleton() {
  const widths = ["38%", "52%", "30%"]
  return (
    <section className="mb-[22px]" data-testid="cron-skeleton" aria-hidden>
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
        <span className="h-3 w-16 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      </div>
      <div className="glass-card rounded-[var(--radius-xl)] p-[5px]">
        {widths.map((w, i) => (
          <div key={i} className="flex min-h-[56px] items-center gap-2.5 py-2 pl-2.5 pr-3">
            <span
              className="size-6 flex-none rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ animationDelay: `${i * 200}ms` }}
            />
            <span className="flex flex-1 flex-col gap-2">
              <span
                className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                style={{ width: w, animationDelay: `${i * 200}ms` }}
              />
              <span
                className="h-2.5 w-[58%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                style={{ animationDelay: `${i * 200}ms` }}
              />
            </span>
            <span
              className="h-6 w-11 flex-none rounded-[12px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ animationDelay: `${i * 200}ms` }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
