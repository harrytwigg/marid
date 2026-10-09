/* The task page's two non-document states, kept out of `task-page.tsx` so the
 * page file holds the page. Both are presentational: they take what to show and
 * a way back, and own no state of their own. */

export function TaskPageSkeleton({ mobile, bannerExpected }: { mobile: boolean; bannerExpected: boolean }) {
  const pulse =
    "bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
  return (
    <div data-testid="task-page-skeleton" className="min-w-0" aria-hidden>
      {bannerExpected && (
        <div
          data-testid="task-banner-skeleton"
          className={`mb-3.5 h-[126px] w-full rounded-[var(--radius-xl)] ${pulse}`}
        />
      )}
      {mobile && (
        <div data-testid="task-id-skeleton" className={`mb-1 h-[18px] w-14 rounded-md ${pulse}`} />
      )}
      <div
        data-testid="task-title-skeleton"
        className={`${mobile ? "h-[62px] w-[82%]" : "h-[38px] w-[68%]"} rounded-[10px] ${pulse}`}
      />
      <div className={`mt-3 flex ${mobile ? "h-[34px]" : "h-7"} items-center gap-2`}>
        <span className={`h-full w-[92px] rounded-full ${pulse}`} />
        <span className={`h-full w-[116px] rounded-full ${pulse}`} />
        <span className={`h-full w-[84px] rounded-full ${pulse}`} />
      </div>
      <div data-testid="task-document-skeleton" className="mt-7 space-y-3">
        <div className={`h-3 w-full rounded-md ${pulse}`} />
        <div className={`h-3 w-[88%] rounded-md ${pulse}`} />
        <div className={`h-3 w-[72%] rounded-md ${pulse}`} />
      </div>
      <div data-testid="task-activity" className="pt-3">
        <div className={`h-4 w-20 rounded-md ${pulse}`} />
        <div className={`mt-3 h-[82px] w-full rounded-[var(--radius-lg)] ${pulse}`} />
        <div className={`mt-3 h-[52px] w-[76%] rounded-[var(--radius-lg)] ${pulse}`} />
      </div>
    </div>
  )
}

/** `onBack` absent (a Todo shown as a tab), the tab's own close is the way out. */
export function TaskEmpty({ message, onBack }: { message: string; onBack?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[20px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">{message}</div>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="focus-ring rounded-full px-4 py-2 text-[13px] font-semibold text-[var(--accent)] outline-none hover:bg-[var(--accent-fill)]"
        >
          Back to Todos
        </button>
      )}
    </div>
  )
}
