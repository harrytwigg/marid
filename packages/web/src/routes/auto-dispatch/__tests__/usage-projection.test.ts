import { describe, expect, it } from "vitest"
import type { UsageSample } from "@/lib/api-auto-dispatch"
import { PROJECTION_MIN_SPAN_MS, WEEKLY_PROJECTION_MIN_SPAN_MS, projectWindow, readout, slopePerHour, weeklyVerdicts } from "../usage-projection"

const NOW = Date.parse("2026-09-21T12:00:00Z")
const H = 3_600_000
const reset5h = Math.floor((NOW + 2 * H) / 1000)
const reset7d = Math.floor((NOW + 3 * 24 * H) / 1000)

/** Samples at the given minute offsets before now, with a 5h share per sample. */
function series(points: Array<[minutesAgo: number, used: number]>, extra: (used: number) => UsageSample["windows"] = () => []): UsageSample[] {
  return points.map(([minutesAgo, used]) => ({
    at: NOW - minutesAgo * 60_000,
    windows: [{ name: "5h", usedPercent: used, resetsAt: reset5h }, ...extra(used)],
  }))
}

describe("projectWindow", () => {
  it("fits the rate over the window's readings and anchors the line at the last one", () => {
    // 10%/h for two hours, then a burst: the slope is the fit's, the start is the last reading.
    const projection = projectWindow(series([[120, 10], [90, 15], [60, 20], [30, 25], [0, 40]]), "5h", NOW)
    expect(projection.kind).toBe("projected")
    if (projection.kind !== "projected") return
    expect(projection.from).toEqual({ at: NOW, usedPercent: 40 })
    expect(projection.ratePerHour).toBeCloseTo(slopePerHour([{ at: NOW - 120 * 60_000, usedPercent: 10 }, { at: NOW - 90 * 60_000, usedPercent: 15 }, { at: NOW - 60 * 60_000, usedPercent: 20 }, { at: NOW - 30 * 60_000, usedPercent: 25 }, { at: NOW, usedPercent: 40 }]))
    expect(projection.ratePerHour).toBeGreaterThan(10)
    expect(projection.basisMs).toBe(120 * 60_000)
    expect(projection.atReset).toBeGreaterThan(40)
    expect(projection.atReset).toBeLessThanOrEqual(100)
  })

  it("names exhaustion before the reset, and otherwise what will lapse unused", () => {
    const steep = projectWindow(series([[60, 30], [30, 55], [0, 80]]), "5h", NOW)
    expect(steep.kind).toBe("projected")
    if (steep.kind !== "projected") return
    // 50%/h from 80: 100 in 24 min — inside the 2 h to reset.
    expect(steep.exhaustsAt).toBeCloseTo(NOW + (20 / 50) * H, -3)
    expect(steep.atReset).toBe(100)
    expect(readout(steep, { window: "5h" })).toMatch(/^5h: exhausts the allowance at about .* — refused until the reset/)

    const gentle = projectWindow(series([[60, 30], [30, 33], [0, 36]]), "5h", NOW)
    if (gentle.kind !== "projected") throw new Error(gentle.kind)
    expect(gentle.exhaustsAt).toBeUndefined()
    expect(readout(gentle, { window: "5h" })).toMatch(/^5h: 48% by the reset .*, 52% left to lapse \(linear/)
  })

  it("refuses to project on too few readings or too short a span, and the readout says so", () => {
    expect(projectWindow(series([[10, 12], [0, 13]]), "5h", NOW)).toEqual({ kind: "none", reason: "too-few" })
    // Three integer-rounded readings a minute apart would fit 30%/h from noise.
    const short = projectWindow(series([[2, 12], [1, 12], [0, 13]]), "5h", NOW)
    expect(short).toEqual({ kind: "none", reason: "too-short" })
    expect(readout(short, { window: "5h" })).toMatch(/rate not known yet — needs three readings over 30 min/)
    expect(PROJECTION_MIN_SPAN_MS).toBe(30 * 60_000)
    expect(projectWindow([], "5h", NOW)).toEqual({ kind: "none", reason: "no-window" })
  })

  it("reads a non-positive slope over a long span as flat", () => {
    const flat = projectWindow(series([[120, 40], [60, 40], [0, 40]]), "5h", NOW)
    expect(flat).toMatchObject({ kind: "flat", usedPercent: 40 })
    expect(readout(flat, { window: "5h" })).toMatch(/^5h: flat at 40%/)
  })

  it("groups by reset, so a new window's lower number is not a falling rate", () => {
    const rolled: UsageSample[] = [
      ...series([[180, 60], [150, 70], [120, 80]]).map((sample) => ({ ...sample, windows: [{ ...sample.windows[0], resetsAt: reset5h - 5 * 3600 }] })),
      ...series([[60, 5], [30, 10], [0, 15]]),
    ]
    const projection = projectWindow(rolled, "5h", NOW)
    if (projection.kind !== "projected") throw new Error(projection.kind)
    expect(projection.from.usedPercent).toBe(15)
    expect(projection.ratePerHour).toBeCloseTo(10)
    expect(projection.basisMs).toBe(60 * 60_000)
  })

})

describe("weekly minimum span", () => {
  it("refuses a weekly bucket on two hours of readings, and says how much it needs", () => {
    const samples: UsageSample[] = [120, 60, 0].map((minutesAgo, i) => ({
      at: NOW - minutesAgo * 60_000,
      windows: [{ name: "7d", usedPercent: 60 + i, resetsAt: reset7d }],
    }))
    const projection = projectWindow(samples, "7d", NOW)
    expect(projection).toEqual({ kind: "none", reason: "too-short" })
    expect(readout(projection, { window: "7d" })).toMatch(/needs three readings over 6 h/)
    expect(WEEKLY_PROJECTION_MIN_SPAN_MS).toBe(6 * 60 * 60_000)
  })
})

describe("a window that no longer exists", () => {
  it("gives no verdict for a five-hour window whose reset has passed", () => {
    const gone: UsageSample[] = [180, 150, 120].map((minutesAgo, i) => ({
      at: NOW - minutesAgo * 60_000,
      windows: [{ name: "5h", usedPercent: 60 + i * 5, resetsAt: Math.floor((NOW - 2 * H) / 1000) }],
    }))
    const projection = projectWindow(gone, "5h", NOW)
    expect(projection).toEqual({ kind: "none", reason: "reset-passed" })
    expect(readout(projection, { window: "5h" })).toMatch(/window has reset — waiting for a reading/)
  })

  it("does not let a bucket the account stopped reporting lead the weekly verdict", () => {
    const lastWeek = Math.floor((NOW - 2 * H) / 1000)
    const thisWeek = Math.floor((NOW + 5 * 24 * H) / 1000)
    const samples: UsageSample[] = []
    // Ten readings of last week with a hot per-model bucket, then the new week without it.
    for (let i = 0; i < 10; i++) {
      samples.push({ at: NOW - (30 - i) * H, windows: [
        { name: "7d", usedPercent: 40 + i, resetsAt: lastWeek },
        { name: "7d Fable", usedPercent: 80 + i * 2, resetsAt: lastWeek },
      ] })
    }
    for (let i = 0; i < 8; i++) samples.push({ at: NOW - (7 - i) * H, windows: [{ name: "7d", usedPercent: 5 + i, resetsAt: thisWeek }] })
    const verdicts = weeklyVerdicts(samples, NOW)
    expect(verdicts.map((verdict) => verdict.name)).toEqual(["7d"])
    expect(verdicts[0].projection.kind).toBe("projected")
    // Asked for directly, the stale bucket says why it has nothing to say.
    expect(projectWindow(samples, "7d Fable", NOW)).toEqual({ kind: "none", reason: "reset-passed" })
  })
})

describe("weeklyVerdicts", () => {
  it("projects every weekly bucket and leads with the one that exhausts first", () => {
    const samples = series(
      [[6 * 60, 0], [3 * 60, 0], [0, 0]],
      (_) => [] ,
    ).map((sample, i) => ({
      ...sample,
      windows: [
        ...sample.windows,
        { name: "7d", usedPercent: 60 + i * 2, resetsAt: reset7d },
        { name: "7d Fable", usedPercent: 70 + i * 10, resetsAt: reset7d },
      ],
    }))
    const verdicts = weeklyVerdicts(samples, NOW)
    expect(verdicts.map((verdict) => verdict.name)).toEqual(["7d Fable", "7d"])
    const lead = verdicts[0].projection
    if (lead.kind !== "projected") throw new Error(lead.kind)
    expect(lead.exhaustsAt).toBeDefined()
    expect(readout(lead, { window: "7d Fable" })).toMatch(/^7d Fable: exhausts the allowance/)
  })
})
