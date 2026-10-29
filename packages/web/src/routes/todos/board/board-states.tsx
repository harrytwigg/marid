import { operatorSafeTodoError } from "@/lib/todos"

/** In a chat layout tab the columns keep a readable width and the strip scrolls sideways, whatever
 *  the pane's width: the route's columns share the screen's. */
export const TAB_COLUMNS = "[&>[data-board-column]]:min-w-[238px]"

export function BoardErrorCard({ error, testId = "board-error" }: { error: unknown; testId?: string }) {
  return (
    <div className="px-10 pt-5 max-[700px]:px-0 max-[700px]:pt-2">
      <div
        data-testid={testId}
        className="max-w-[560px] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-4 text-[length:var(--text-subheadline)] text-[var(--system-red)]"
      >
        {operatorSafeTodoError(error, "Couldn't load this board")}
      </div>
    </div>
  )
}



/** Loading keeps exact card geometry so nothing shifts when data lands
 *  (states mock §6 .skel-col: 56px overline bar, 85%/55% title bars). */
export function BoardSkeleton({ embedded = false }: { embedded?: boolean }) {
  const cardsPerColumn = [3, 2, 3, 2, 1]
  return (
    <div className={`flex min-h-full items-start gap-3 px-10 pb-8 pt-5 max-[700px]:w-max max-[700px]:px-4 max-[700px]:pt-3 ${embedded ? TAB_COLUMNS : ""}`} data-testid="board-skeleton" aria-hidden>
      {cardsPerColumn.map((cards, column) => (
        <div key={column} data-board-column="loading" className="flex min-w-0 flex-1 flex-col max-[700px]:w-[84vw] max-[700px]:flex-none">
          <div className="flex items-center gap-2 px-[11px] pb-2.5 pt-0.5">
            <span className="size-5 rounded-full bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
            <span className="h-3 w-[74px] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: cards }, (_, i) => (
              <div
                key={i}
                data-board-skeleton-card=""
                className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] px-[13px] py-3 shadow-[var(--shadow-ambient),var(--shadow-subtle)]"
              >
                <div
                  className="h-2.5 w-14 rounded-[5px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                  style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                />
                <div
                  className="mt-[9px] h-[13px] w-[85%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                  style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                />
                {i % 3 !== 2 && (
                  <div
                    className="mt-[5px] h-[13px] w-[55%] rounded-[6px] bg-[var(--fill-tertiary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
                    style={{ animationDelay: `${(column * 2 + i) * 120}ms` }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <div
        data-testid="board-skeleton-closed-rail"
        className="h-24 w-11 flex-none rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] motion-safe:animate-[skeletonPulse_1.6s_var(--ease-smooth)_infinite]"
      />
    </div>
  )
}
