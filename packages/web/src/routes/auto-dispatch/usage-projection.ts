import type { UsageSample } from "@/lib/api-auto-dispatch"
import { formatMinutes, shortClock } from "./format"

/**
 * Where a window is heading, from the readings the gateway kept (
 * FR-011). Pure: samples and an injected `now` in; a projection or
 * a reason there is none out. Nothing here is persisted or logged — the board
 * walk gets its own prediction in its capacity snapshot, and a projection on the wire
 * beside real samples would sooner or later be read as a reading.
 *
 * The operator asked for "a simple rate-based projection, not a real
 * forecasting model", so this is a straight line, bounded four ways: the fit
 * supplies only its slope and the line is anchored at the last reading (usage
 * is bursty; a whole-window fit averages across idle gaps); it needs three
 * readings spanning half an hour (used share is a whole number, so two
 * readings a minute apart at 12% and 13% would fit 60%/h); the projected
 * value is clamped at 100; a non-positive slope reads as flat, since a drop
 * within one reset instant cannot happen — a lower number is a new window.
 */

export const PROJECTION_MIN_SAMPLES = 3
/** Half an hour is the floor for a five-hour window. A weekly bucket needs
 *  far more: one quantised 1% step over 30 minutes is 2%/h, which over a week
 *  is "exhausts tonight" in the card's largest text, wrong by construction
 *  for the first hours after install. Six hours before the week says anything. */
export const PROJECTION_MIN_SPAN_MS = 30 * 60_000
export const WEEKLY_PROJECTION_MIN_SPAN_MS = 6 * 60 * 60_000

export const isWeekly = (name: string): boolean => name === "7d" || name.startsWith("7d ")
export const minSpanFor = (name: string): number => (isWeekly(name) ? WEEKLY_PROJECTION_MIN_SPAN_MS : PROJECTION_MIN_SPAN_MS)

export interface WindowPoint {
  at: number
  usedPercent: number
}

export type Projection =
  | { kind: "none"; reason: "no-window" | "too-few" | "too-short" | "reset-passed" }
  | { kind: "flat"; usedPercent: number; basisMs: number; resetAt: number }
  | {
      kind: "projected"
      /** The fit's slope, in used-percent per hour. */
      ratePerHour: number
      /** First-to-last span of the readings the slope came from. */
      basisMs: number
      /** The last reading — where the drawn line starts. */
      from: WindowPoint
      resetAt: number
      /** Used share expected at the reset, clamped at 100. */
      atReset: number
      /** When 100 is reached, if before the reset. */
      exhaustsAt?: number
    }

/** The readings of one window: those sharing the reset instant of the latest
 *  sample that carries the window. A drop in the number is a new window, and
 *  a new window is a new reset, so grouping by reset is what separates them. */
export function currentWindowPoints(samples: readonly UsageSample[], name: string): { points: WindowPoint[]; resetAt: number } | null {
  let resetsAt: number | undefined
  for (let i = samples.length - 1; i >= 0 && resetsAt === undefined; i--) {
    resetsAt = samples[i].windows.find((window) => window.name === name)?.resetsAt
  }
  if (resetsAt === undefined) return null
  const points: WindowPoint[] = []
  for (const sample of samples) {
    const window = sample.windows.find((entry) => entry.name === name && entry.resetsAt === resetsAt)
    if (window) points.push({ at: sample.at, usedPercent: window.usedPercent })
  }
  return { points, resetAt: resetsAt * 1000 }
}

/** Least-squares slope in used-percent per hour. */
export function slopePerHour(points: readonly WindowPoint[]): number {
  const n = points.length
  const meanT = points.reduce((sum, point) => sum + point.at, 0) / n
  const meanY = points.reduce((sum, point) => sum + point.usedPercent, 0) / n
  let num = 0
  let den = 0
  for (const point of points) {
    const dt = point.at - meanT
    num += dt * (point.usedPercent - meanY)
    den += dt * dt
  }
  return den === 0 ? 0 : (num / den) * 3_600_000
}

export function projectWindow(samples: readonly UsageSample[], name: string, now: number): Projection {
  const current = currentWindowPoints(samples, name)
  if (!current) return { kind: "none", reason: "no-window" }
  const { points, resetAt } = current
  // A window whose reset has passed no longer exists — the gateway may have
  // been down, or this is the gap after a roll before the new window reports
  // a reset. Projecting it would be a verdict about a window that is gone.
  if (resetAt <= now) return { kind: "none", reason: "reset-passed" }
  if (points.length < PROJECTION_MIN_SAMPLES) return { kind: "none", reason: "too-few" }
  const basisMs = points[points.length - 1].at - points[0].at
  if (basisMs < minSpanFor(name)) return { kind: "none", reason: "too-short" }
  const from = points[points.length - 1]
  const rate = slopePerHour(points)
  if (rate <= 0) return { kind: "flat", usedPercent: from.usedPercent, basisMs, resetAt }
  const at = (level: number): number | undefined => {
    if (from.usedPercent >= level) return undefined
    const when = from.at + ((level - from.usedPercent) / rate) * 3_600_000
    return when <= resetAt ? when : undefined
  }
  const atReset = Math.min(100, from.usedPercent + (rate * (resetAt - from.at)) / 3_600_000)
  return {
    kind: "projected", ratePerHour: rate, basisMs, from, resetAt, atReset,
    exhaustsAt: at(100),
  }
}

const basis = (ms: number): string => `linear, at the last ${formatMinutes(ms / 60_000)} rate`

/** One sentence the operator can act on; 100% is the real warning. */
export function readout(projection: Projection, label: { window: string }): string {
  switch (projection.kind) {
    case "none":
      if (projection.reason === "no-window") return `${label.window}: no reading with a reset yet`
      if (projection.reason === "reset-passed") return `${label.window}: window has reset — waiting for a reading of the new one`
      return `${label.window}: rate not known yet — needs three readings over ${formatMinutes(minSpanFor(label.window) / 60_000)}`
    case "flat":
      return `${label.window}: flat at ${Math.round(projection.usedPercent)}% (${basis(projection.basisMs)}); resets ${shortClock(projection.resetAt)}`
    case "projected": {
      const tail = `(${basis(projection.basisMs)})`
      if (projection.exhaustsAt !== undefined) {
        return `${label.window}: exhausts the allowance at about ${shortClock(projection.exhaustsAt)} — refused until the reset ${shortClock(projection.resetAt)} ${tail}`
      }
      const reach = `${Math.round(projection.atReset)}% by the reset ${shortClock(projection.resetAt)}`
      return `${label.window}: ${reach}, ${Math.max(0, 100 - Math.round(projection.atReset))}% left to lapse ${tail}`
    }
  }
}

/** The weekly buckets the account reports NOW: those in the latest sample
 *  that carries any weekly window. A per-model bucket used last week and
 *  untouched this week drops out of the readings (the sampler keeps no
 *  window without a reset), and a stale bucket must not lead the card. */
export function currentWeeklyNames(samples: readonly UsageSample[]): string[] {
  for (let i = samples.length - 1; i >= 0; i--) {
    const names = samples[i].windows.filter((window) => isWeekly(window.name)).map((window) => window.name)
    if (names.length > 0) return names
  }
  return []
}

/** Every weekly bucket the account currently reports, worst first: soonest
 *  exhaustion, then highest share at the reset. */
export function weeklyVerdicts(samples: readonly UsageSample[], now: number): Array<{ name: string; projection: Projection }> {
  const names = new Set(currentWeeklyNames(samples))
  const rank = (projection: Projection): number => {
    if (projection.kind !== "projected") return Number.POSITIVE_INFINITY
    if (projection.exhaustsAt !== undefined) return projection.exhaustsAt
    return 1e16 - projection.atReset
  }
  return [...names]
    .map((name) => ({ name, projection: projectWindow(samples, name, now) }))
    .sort((a, b) => rank(a.projection) - rank(b.projection) || a.name.localeCompare(b.name))
}
