import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react"
import type { IdleCapacityStart, UsageSample } from "@/lib/api-idle-capacity"
import { shortClock } from "./format"
import { buildChartModel, type ChartFrame, type ChartModel, type ChartPoint } from "./usage-chart-model"
import type { Projection } from "./usage-projection"

/**
 * The usage graph: the five-hour used share over the last twelve hours with
 * the weekly buckets beneath it, the loop's starts and the window resets on
 * the same axis, and the projection as a dashed line from the last reading
 * to the reset against the tier's start gate. Inline SVG; the geometry is
 * usage-chart-model.ts and this only draws it.
 */

const HEIGHT = 200
const INSET = { left: 36, right: 12, top: 14, bottom: 26 }
const SERIES_STROKE: Record<string, string> = { "5h": "var(--accent)" }
const WEEKLY_STROKE = "var(--text-quaternary)"

function useElementWidth(fallback: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? fallback)
      if (next > 0) setWidth(next)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fallback])
  return [ref, width]
}

const path = (points: ChartPoint[]): string => points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")

/** The series name at its line's end — inside the plot when the line ends
 *  near the right edge, so a phone-width chart does not clip it. */
function EndLabel({ name, last, right }: { name: string; last: ChartPoint; right: number }) {
  const room = right - last.x
  const inward = room < 8 + name.length * 6
  return (
    <text x={inward ? last.x - 4 : last.x + 4} y={last.y - 4} fontSize={10} textAnchor={inward ? "end" : "start"} fill="var(--text-tertiary)">{name}</text>
  )
}

function Series({ model }: { model: ChartModel }) {
  return (
    <>
      {model.series.map((series) => (
        <g key={series.name} data-series={series.name}>
          {series.segments.map((segment, i) => segment.length > 1
            ? <path key={i} d={path(segment)} fill="none" stroke={SERIES_STROKE[series.name] ?? WEEKLY_STROKE} strokeWidth={series.name === "5h" ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round" />
            : <circle key={i} cx={segment[0].x} cy={segment[0].y} r={2} fill={SERIES_STROKE[series.name] ?? WEEKLY_STROKE} />)}
          {series.segments.length > 0 && <EndLabel name={series.name} last={series.segments[series.segments.length - 1].at(-1)!} right={model.x(model.domain.end)} />}
        </g>
      ))}
    </>
  )
}

function Markers({ model }: { model: ChartModel }) {
  const top = INSET.top
  const bottom = HEIGHT - INSET.bottom
  return (
    <>
      {model.resets.map((reset) => (
        <g key={reset.at} data-marker="reset">
          <line x1={reset.x} x2={reset.x} y1={top} y2={bottom} stroke="var(--text-quaternary)" strokeWidth={1} />
          <text x={reset.x + 3} y={top + 9} fontSize={9} fill="var(--text-tertiary)">reset</text>
        </g>
      ))}
      {model.ceiling && (
        <g data-marker="ceiling">
          <line x1={INSET.left} x2={model.x(model.domain.end)} y1={model.ceiling.y} y2={model.ceiling.y} stroke="var(--system-orange)" strokeWidth={1} />
          <text x={model.x(model.domain.end) - 2} y={model.ceiling.y - 3} fontSize={9} textAnchor="end" fill="var(--text-tertiary)">gate {model.ceiling.percent}%</text>
        </g>
      )}
      {model.projection && (
        <line data-marker="projection" x1={model.projection.from.x} y1={model.projection.from.y} x2={model.projection.to.x} y2={model.projection.to.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 4" strokeLinecap="round" />
      )}
      <line data-marker="now" x1={model.nowX} x2={model.nowX} y1={top} y2={bottom} stroke="var(--separator)" strokeWidth={1} />
      {model.starts.map((start) => (
        <circle key={start.start.commentId} data-marker="start" cx={start.x} cy={start.y} r={5} fill="var(--system-green)" stroke="var(--bg-secondary)" strokeWidth={2}>
          <title>{start.start.workItemId} started {shortClock(Date.parse(start.start.startedAt))}</title>
        </circle>
      ))}
    </>
  )
}

function Axes({ model, width }: { model: ChartModel; width: number }) {
  return (
    <>
      {[0, 50, 100].map((percent) => (
        <g key={percent}>
          <line x1={INSET.left} x2={width - INSET.right} y1={model.y(percent)} y2={model.y(percent)} stroke="var(--separator)" strokeWidth={1} />
          <text x={INSET.left - 6} y={model.y(percent) + 3} fontSize={10} textAnchor="end" fill="var(--text-tertiary)">{percent}%</text>
        </g>
      ))}
      {model.ticks.map((tick) => (
        <text key={tick.at} x={tick.x} y={HEIGHT - 8} fontSize={10} textAnchor="middle" fill="var(--text-tertiary)">
          {new Date(tick.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </text>
      ))}
    </>
  )
}

function nearest(samples: readonly UsageSample[], model: ChartModel, px: number): UsageSample | undefined {
  let best: UsageSample | undefined
  let distance = Number.POSITIVE_INFINITY
  for (const sample of samples) {
    if (sample.at < model.domain.start || sample.at > model.domain.end) continue
    const d = Math.abs(model.x(sample.at) - px)
    if (d < distance) { distance = d; best = sample }
  }
  return best
}

export function UsageChart({ samples, starts, projection, ceiling, now }: {
  samples: readonly UsageSample[]
  starts: readonly IdleCapacityStart[]
  projection?: Projection
  ceiling?: number
  now: number
}) {
  const [ref, width] = useElementWidth(640)
  const frame: ChartFrame = useMemo(() => ({ width, height: HEIGHT, inset: INSET }), [width])
  const model = useMemo(() => buildChartModel({ samples, starts, projection, ceiling, now, frame }), [samples, starts, projection, ceiling, now, frame])
  const [hover, setHover] = useState<UsageSample | null>(null)
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setHover(nearest(samples, model, ((event.clientX - box.left) / box.width) * width) ?? null)
  }

  if (model.state === "waiting") {
    return (
      <div ref={ref} data-testid="usage-chart" className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
        Waiting for readings — the gateway keeps one every five minutes while it reads the account.
      </div>
    )
  }
  return (
    <div ref={ref} data-testid="usage-chart" className="relative">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        aria-label={`Five-hour and weekly usage over the last twelve hours with ${model.starts.length} auto-start${model.starts.length === 1 ? "" : "s"} and ${model.resets.length} reset${model.resets.length === 1 ? "" : "s"} marked`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <Axes model={model} width={width} />
        <Series model={model} />
        <Markers model={model} />
        {hover && <line x1={model.x(hover.at)} x2={model.x(hover.at)} y1={INSET.top} y2={HEIGHT - INSET.bottom} stroke="var(--text-tertiary)" strokeWidth={1} />}
      </svg>
      {hover && (
        <div role="status" className="pointer-events-none absolute left-[var(--space-2)] top-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--bg-primary)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] shadow-[var(--shadow-card)]">
          <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{shortClock(hover.at)}</span>
          {hover.windows.map((window) => <span key={window.name} className="ml-[var(--space-2)]">{window.name} {window.usedPercent}%</span>)}
        </div>
      )}
    </div>
  )
}
