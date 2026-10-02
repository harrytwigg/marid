import type { StartedSession, UsageSample } from "@/lib/api-auto-dispatch"
import type { Projection } from "./usage-projection"

/**
 * The usage graph's geometry (US4), pure: samples, the sessions started
 * on the engine and a projection in; pixel coordinates out. The chart component only draws.
 */

export interface ChartFrame {
  width: number
  height: number
  /** Left / right / top / bottom insets for axis text. */
  inset: { left: number; right: number; top: number; bottom: number }
}

export interface ChartPoint { x: number; y: number; at: number; usedPercent: number }

export interface ChartModel {
  state: "waiting" | "ready"
  /** Time domain, epoch ms: the tail back to `now`, extended to the reset when projecting. */
  domain: { start: number; end: number }
  x: (at: number) => number
  y: (percent: number) => number
  /** Polylines per series, split where the window is absent from consecutive samples. */
  series: Array<{ name: string; segments: ChartPoint[][] }>
  /** Where the five-hour window rolled: between two consecutive readings that
   *  carry it with different resets. An untouched window right after a roll
   *  reports no reset and so has no entry in between; the change is still
   *  found across that gap (A, absent × n, B), which is the marker the
   *  operator most wants. */
  resets: Array<{ x: number; at: number }>
  /** Sessions started in the tail, placed on the five-hour line as it read then. */
  starts: Array<{ x: number; y: number; start: StartedSession }>
  /** Hour ticks along the domain, at clean local hours. */
  ticks: Array<{ x: number; at: number }>
  projection?: { from: ChartPoint; to: ChartPoint; dashed: true }
  nowX: number
}

export const DEFAULT_TAIL_MS = 12 * 60 * 60_000

function scales(frame: ChartFrame, domain: { start: number; end: number }) {
  const plotWidth = frame.width - frame.inset.left - frame.inset.right
  const plotHeight = frame.height - frame.inset.top - frame.inset.bottom
  const span = Math.max(1, domain.end - domain.start)
  return {
    x: (at: number) => frame.inset.left + ((at - domain.start) / span) * plotWidth,
    y: (percent: number) => frame.inset.top + (1 - Math.max(0, Math.min(100, percent)) / 100) * plotHeight,
  }
}

function seriesSegments(samples: readonly UsageSample[], name: string, x: ChartModel["x"], y: ChartModel["y"]): ChartPoint[][] {
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  for (const sample of samples) {
    const window = sample.windows.find((entry) => entry.name === name)
    if (!window) {
      if (current.length) segments.push(current)
      current = []
      continue
    }
    current.push({ x: x(sample.at), y: y(window.usedPercent), at: sample.at, usedPercent: window.usedPercent })
  }
  if (current.length) segments.push(current)
  return segments
}

/** Resets of the five-hour window, found between consecutive samples that
 *  CARRY it — a sample without the window is skipped, not treated as a break. */
export function fiveHourResets(samples: readonly UsageSample[]): number[] {
  const out: number[] = []
  let previous: { at: number; resetsAt: number } | undefined
  for (const sample of samples) {
    const window = sample.windows.find((entry) => entry.name === "5h")
    if (!window) continue
    if (previous && window.resetsAt !== previous.resetsAt) out.push((previous.at + sample.at) / 2)
    previous = { at: sample.at, resetsAt: window.resetsAt }
  }
  return out
}

function hourTicks(domain: { start: number; end: number }): number[] {
  const first = new Date(domain.start)
  first.setMinutes(0, 0, 0)
  const hours = (domain.end - domain.start) / 3_600_000
  const step = hours > 18 ? 6 : hours > 8 ? 3 : 1
  const ticks: number[] = []
  for (let t = first.getTime(); t <= domain.end; t += step * 3_600_000) if (t >= domain.start) ticks.push(t)
  return ticks
}

/** The five-hour share as the last reading at or before `at` showed it. */
function fiveHourAt(samples: readonly UsageSample[], at: number): number {
  let used = 0
  for (const sample of samples) {
    if (sample.at > at) break
    const window = sample.windows.find((entry) => entry.name === "5h")
    if (window) used = window.usedPercent
  }
  return used
}

export function buildChartModel(input: {
  samples: readonly UsageSample[]
  starts: readonly StartedSession[]
  projection?: Projection
  now: number
  frame: ChartFrame
  tailMs?: number
}): ChartModel {
  const { frame, now } = input
  const tail = input.tailMs ?? DEFAULT_TAIL_MS
  const projected = input.projection?.kind === "projected" ? input.projection : undefined
  const domain = { start: now - tail, end: Math.max(now, projected?.resetAt ?? now) }
  const { x, y } = scales(frame, domain)
  const inRange = input.samples.filter((sample) => sample.at >= domain.start && sample.at <= now)
  const names = ["5h", ...new Set(inRange.flatMap((sample) => sample.windows.map((window) => window.name)).filter((name) => name !== "5h"))]
  const model: ChartModel = {
    state: inRange.length >= 2 ? "ready" : "waiting",
    domain, x, y,
    series: names.map((name) => ({ name, segments: seriesSegments(inRange, name, x, y) })),
    resets: fiveHourResets(inRange).map((at) => ({ x: x(at), at })),
    starts: input.starts
      .map((start) => ({ start, at: Date.parse(start.createdAt) }))
      .filter(({ at }) => at >= domain.start && at <= now)
      .map(({ start, at }) => ({ x: x(at), y: y(fiveHourAt(inRange, at)), start })),
    ticks: hourTicks(domain).map((at) => ({ x: x(at), at })),
    nowX: x(now),
  }
  if (projected) {
    model.projection = {
      from: { x: x(projected.from.at), y: y(projected.from.usedPercent), at: projected.from.at, usedPercent: projected.from.usedPercent },
      to: { x: x(projected.resetAt), y: y(projected.atReset), at: projected.resetAt, usedPercent: projected.atReset },
      dashed: true,
    }
  }
  return model
}
