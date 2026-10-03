/** The grouped-list skeleton (mobile/inbox loading) — moved out of board-page.tsx;
 *  it first came from the retired legacy list's group module at the stage-C cutover. */
export function GroupSkeleton() {
  const widths = ["46%", "58%", "38%"]
  const metas = [64, 40, 52]
  return (
    <section className="mb-[22px]" data-testid="todos-skeleton" aria-hidden>
      <div className="flex items-center gap-2 px-1.5 pb-2">
        <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
        <span className="h-3 w-16 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
      </div>
      <div className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] p-[5px] shadow-[var(--shadow-card)]">
        {widths.map((w, i) => (
          <div key={i} className="flex min-h-[46px] items-center gap-2.5 py-[7px] pl-2 pr-3">
            <span
              className="ml-[24px] size-6 flex-none rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite] max-[500px]:ml-0"
              style={{ animationDelay: `${i * 200}ms` }}
            />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: w, animationDelay: `${i * 200}ms` }}
            />
            <span className="flex-1" />
            <span
              className="h-3 rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
              style={{ width: metas[i], animationDelay: `${i * 200}ms` }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
