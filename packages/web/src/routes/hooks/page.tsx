import { useCallback, type ReactNode } from "react"
import { RefreshCw } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import type { HookRun } from "@/lib/api-hooks"
import { HooksList } from "./hooks-list"
import { RunLog } from "./run-log"
import { appliedTodo, useHookRunParams } from "./use-hook-params"
import { useHookRuns, useHooks, useNowTick } from "./use-hooks"

/**
 * Hooks: the board hooks the gateway is configured to run, and the log of what
 * they have done. Read-and-toggle — the hooks themselves are `config.yaml`,
 * written up in `docs/board-hooks.md`. The live `hooks:run` event that pushes
 * new runs is wired by the shell; this page polls in the meantime.
 */

function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button variant="ghost" size="icon" onClick={onClick} aria-label="Refresh" aria-busy={busy}>
      <RefreshCw size={17} className={busy ? "animate-spin" : ""} />
    </Button>
  )
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-lg)] p-[10px_13px] text-[length:var(--text-footnote)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
    >
      {children}
    </div>
  )
}

function flattenRuns(pages: readonly { runs: HookRun[] }[] | undefined): HookRun[] {
  return pages?.flatMap((page) => page.runs) ?? []
}

/** The failure text a query carries, or null when it did not fail. */
function errorText(query: { isError: boolean; error: unknown }, fallback: string): string | null {
  if (!query.isError) return null
  return query.error instanceof Error && query.error.message ? query.error.message : fallback
}

export default function HooksPage() {
  const hooksQuery = useHooks()
  const params = useHookRunParams()
  const runsQuery = useHookRuns({ hook: params.hook, outcome: params.outcome, todo: appliedTodo(params.todo) })
  const now = useNowTick()

  const hooks = hooksQuery.data?.hooks ?? []
  const runs = flattenRuns(runsQuery.data?.pages)
  const hookError = errorText(hooksQuery, "Failed to read hooks.")
  const runError = errorText(runsQuery, "Failed to read the run log.")

  const refresh = useCallback(() => {
    void hooksQuery.refetch()
    void runsQuery.refetch()
  }, [hooksQuery, runsQuery])

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="960px"
        header={
          <LargeTitleHeader
            title="Hooks"
            subtitle="Reactions the gateway runs when a Todo moves"
            trailing={<RefreshButton onClick={refresh} busy={hooksQuery.isFetching || runsQuery.isFetching} />}
          />
        }
      >
        <div className="grid gap-[var(--space-5)]">
          {hookError && <Alert>{hookError}</Alert>}
          <HooksList hooks={hooks} problems={hooksQuery.data?.problems ?? []} loading={hooksQuery.isLoading} now={now} />
          <RunLog
            runs={runs}
            hookNames={hooks.map((hook) => hook.name)}
            params={params}
            loading={runsQuery.isLoading}
            error={runError}
            hasMore={runsQuery.hasNextPage ?? false}
            loadingMore={runsQuery.isFetchingNextPage}
            onLoadMore={() => void runsQuery.fetchNextPage()}
            now={now}
          />
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
