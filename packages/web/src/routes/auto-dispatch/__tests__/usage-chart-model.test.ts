import { describe, expect, it } from "vitest"
import type { IdleCapacityStart, UsageSample } from "@/lib/api-idle-capacity"
import { buildChartModel, fiveHourResets } from "../usage-chart-model"

const NOW = Date.parse("2026-09-21T12:00:00Z")
const H = 3_600_000
const frame = { width: 640, height: 200, inset: { left: 32, right: 16, top: 12, bottom: 24 } }

const sample = (minutesAgo: number, windows: UsageSample["windows"]): UsageSample => ({ at: NOW - minutesAgo * 60_000, windows })
const fiveHour = (used: number, resetsAt: number) => ({ name: "5h", usedPercent: used, resetsAt })
const RESET_A = Math.floor((NOW - 2 * H) / 1000)
const RESET_B = Math.floor((NOW + 3 * H) / 1000)

describe("fiveHourResets", () => {
  it("finds the roll between consecutive readings that carry the window, across a no-reset gap", () => {
    const samples = [
      sample(200, [fiveHour(70, RESET_A)]),
      sample(150, [fiveHour(80, RESET_A)]),
      // The untouched new window reports no reset: no 5h entry at all.
      sample(120, [{ name: "7d", usedPercent: 50, resetsAt: RESET_B }]),
      sample(100, [{ name: "7d", usedPercent: 50, resetsAt: RESET_B }]),
      sample(60, [fiveHour(5, RESET_B)]),
      sample(0, [fiveHour(12, RESET_B)]),
    ]
    expect(fiveHourResets(samples)).toEqual([NOW - ((150 + 60) / 2) * 60_000])
  })

  it("places no marker when the reset never changes", () => {
    expect(fiveHourResets([sample(60, [fiveHour(5, RESET_B)]), sample(0, [fiveHour(12, RESET_B)])])).toEqual([])
  })
})

describe("buildChartModel", () => {
  it("waits with fewer than two readings in the tail", () => {
    const model = buildChartModel({ samples: [sample(0, [fiveHour(1, RESET_B)])], starts: [], now: NOW, frame })
    expect(model.state).toBe("waiting")
  })

  it("splits a series where the window is absent, marks starts on the 5h line, and extends the domain to the reset when projecting", () => {
    const samples = [
      sample(180, [fiveHour(70, RESET_A)]),
      sample(120, [{ name: "7d", usedPercent: 50, resetsAt: RESET_B }]),
      sample(60, [fiveHour(5, RESET_B), { name: "7d", usedPercent: 51, resetsAt: RESET_B }]),
      sample(0, [fiveHour(12, RESET_B), { name: "7d", usedPercent: 52, resetsAt: RESET_B }]),
    ]
    const start = { workItemId: "PLA-1", commentId: "c", startedAt: new Date(NOW - 30 * 60_000).toISOString(), title: "t", status: "done", partial: false, weekly: [], fiveHour: { name: "5h", usedPercent: 8, minutesToReset: 200 } } as IdleCapacityStart
    const model = buildChartModel({
      samples, starts: [start], now: NOW, frame,
      projection: { kind: "projected", ratePerHour: 7, basisMs: H, from: { at: NOW, usedPercent: 12 }, resetAt: RESET_B * 1000, atReset: 33, aboveGate: false },
      ceiling: 50,
    })
    expect(model.state).toBe("ready")
    expect(model.domain).toEqual({ start: NOW - 12 * H, end: RESET_B * 1000 })
    expect(model.series[0].name).toBe("5h")
    expect(model.series[0].segments.map((segment) => segment.length)).toEqual([1, 2])
    expect(model.series[1].name).toBe("7d")
    expect(model.starts).toHaveLength(1)
    expect(model.starts[0].y).toBe(model.y(8))
    expect(model.projection?.to.y).toBe(model.y(33))
    expect(model.ceiling).toEqual({ y: model.y(50), percent: 50 })
    expect(model.nowX).toBeLessThan(model.projection!.to.x)
    expect(model.x(model.domain.start)).toBe(frame.inset.left)
    expect(model.y(0)).toBe(frame.height - frame.inset.bottom)
  })

  it("leaves a start outside the tail off the chart", () => {
    const start = { workItemId: "PLA-1", commentId: "c", startedAt: new Date(NOW - 13 * H).toISOString(), title: "t", status: "done", partial: false, weekly: [] } as IdleCapacityStart
    const model = buildChartModel({ samples: [sample(60, [fiveHour(5, RESET_B)]), sample(0, [fiveHour(12, RESET_B)])], starts: [start], now: NOW, frame })
    expect(model.starts).toEqual([])
    expect(model.ticks.length).toBeGreaterThan(0)
  })
})
