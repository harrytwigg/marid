
import { useCallback, useEffect, useState } from "react"
import { RefreshCw, Radio } from "@/components/ui/icon"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { LogBrowser, parseLogLine } from "@/components/activity/log-browser"

/* ── Summary Cards ─────────────────────────────────────────────── */

function SummaryCard({
  label,
  value,
  color,
  pulse,
}: {
  label: string
  value: number
  color?: string
  pulse?: boolean
}) {
  return (
    <div className="glass-card rounded-[var(--radius-xl)] p-[var(--space-4)]">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-[var(--weight-medium)] mb-[var(--space-1)]">
        {label}
      </div>
      <div className="flex items-center gap-[var(--space-2)]">
        {pulse && value > 0 && (
          <span className="animate-error-pulse w-2 h-2 rounded-full bg-[var(--system-red)] shrink-0" />
        )}
        <span
          className="text-[length:var(--text-title2)] font-[var(--weight-bold)]"
          style={{ color: color ?? "var(--text-primary)" }}
        >
          {value}
        </span>
      </div>
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────────── */

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [updatedAgo, setUpdatedAgo] = useState("just now")

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .getLogs(500)
      .then((data) => {
        setLines(data.lines ?? [])
        setLastRefresh(new Date())
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Failed to load logs")
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [refresh])

  // Updated ago ticker
  useEffect(() => {
    function tick() {
      const diff = Date.now() - lastRefresh.getTime()
      const secs = Math.floor(diff / 1000)
      if (secs < 10) setUpdatedAgo("just now")
      else if (secs < 60) setUpdatedAgo(`${secs}s ago`)
      else setUpdatedAgo(`${Math.floor(secs / 60)}m ago`)
    }
    tick()
    const interval = setInterval(tick, 10000)
    return () => clearInterval(interval)
  }, [lastRefresh])

  // Parse lines for summary counts
  const entries = lines.map(parseLogLine)
  const totalCount = entries.length
  const errorCount = entries.filter((e) => e.level === "error").length
  const infoCount = entries.filter((e) => e.level === "info").length
  const warnCount = entries.filter((e) => e.level === "warn").length

  const subtitle = loading ? undefined : (
    <>
      {totalCount} event{totalCount !== 1 ? "s" : ""}
      {errorCount > 0 && (
        <span className="text-[var(--system-red)]">
          {" \u00b7 "}
          {errorCount} error{errorCount !== 1 ? "s" : ""}
        </span>
      )}
      {" \u00b7 "}updated {updatedAgo}
    </>
  )

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="960px"
        header={
          <LargeTitleHeader
            title="Activity Console"
            subtitle={subtitle}
            trailing={
              <div className="flex items-center gap-[var(--space-2)]">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.dispatchEvent(new CustomEvent("open-live-stream"))}
                >
                  <Radio size={14} />
                  Open Live Stream
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Refresh logs" onClick={refresh}>
                  <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
                </Button>
              </div>
            }
          />
        }
      >
        <div>
          {error && (
            <div
              className="mb-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] border text-[length:var(--text-footnote)] text-[var(--system-red)]"
              style={{
                background: "color-mix(in srgb, var(--system-red) 7%, transparent)",
                borderColor: "color-mix(in srgb, var(--system-red) 15%, transparent)",
              }}
            >
              Failed to load logs: {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-[200px] text-[var(--text-tertiary)]">
              Loading...
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-[var(--space-3)] mb-[var(--space-4)] md:grid-cols-4">
                <SummaryCard label="Total Events" value={totalCount} />
                <SummaryCard
                  label="Errors"
                  value={errorCount}
                  color={errorCount > 0 ? "var(--system-red)" : "var(--system-green)"}
                  pulse
                />
                <SummaryCard label="Info" value={infoCount} color="var(--system-green)" />
                <SummaryCard label="Warnings" value={warnCount} color="var(--system-orange)" />
              </div>

              <LogBrowser lines={lines} />
            </>
          )}
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
