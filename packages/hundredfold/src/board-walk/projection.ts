import type { UsageSample } from "../shared/claude-usage-history.js";

/**
 * Where a usage window is heading, from the readings the gateway kept: a
 * straight line through the current window's readings, anchored at the last
 * one. The same rule the Auto-Dispatch page draws (packages/web, usage-projection.ts):
 * it needs three readings over half an hour (six hours for a weekly window,
 * where one quantised 1% step would otherwise read as a steep rate), clamps at
 * 100, and reads a falling line as flat — a lower number is a new window.
 *
 * The board walk reads it as a prediction, never as a reading: the snapshot
 * labels it so.
 */

export const PROJECTION_MIN_SAMPLES = 3;
const MIN_SPAN_MS = 30 * 60_000;
const WEEKLY_MIN_SPAN_MS = 6 * 60 * 60_000;

const isWeekly = (name: string): boolean => name === "7d" || name.startsWith("7d ");

export type WindowProjection =
  | { kind: "none"; reason: string }
  | {
      kind: "projected";
      /** Used-percent per hour at the current rate (0 when flat). */
      ratePerHour: number;
      /** Used share expected at the reset, clamped at 100. */
      usedAtReset: number;
      /** The share expected to lapse unused at the reset. */
      unusedAtReset: number;
      /** When 100% is reached, if before the reset (ISO). */
      exhaustsAt?: string;
      /** How much history the rate is drawn from, in minutes. */
      basisMinutes: number;
    };

interface Point { at: number; usedPercent: number }

function currentPoints(samples: readonly UsageSample[], name: string): { points: Point[]; resetAt: number } | null {
  let resetsAt: number | undefined;
  for (let i = samples.length - 1; i >= 0 && resetsAt === undefined; i--) {
    resetsAt = samples[i].windows.find((window) => window.name === name)?.resetsAt;
  }
  if (resetsAt === undefined) return null;
  const points: Point[] = [];
  for (const sample of samples) {
    const window = sample.windows.find((entry) => entry.name === name && entry.resetsAt === resetsAt);
    if (window) points.push({ at: sample.at, usedPercent: window.usedPercent });
  }
  return { points, resetAt: resetsAt * 1000 };
}

function slopePerHour(points: readonly Point[]): number {
  const n = points.length;
  const meanT = points.reduce((sum, point) => sum + point.at, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.usedPercent, 0) / n;
  let num = 0;
  let den = 0;
  for (const point of points) {
    const dt = point.at - meanT;
    num += dt * (point.usedPercent - meanY);
    den += dt * dt;
  }
  return den === 0 ? 0 : (num / den) * 3_600_000;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function projectWindow(samples: readonly UsageSample[], name: string, nowMs: number): WindowProjection {
  const current = currentPoints(samples, name);
  if (!current) return { kind: "none", reason: "no reading of this window with a reset" };
  const { points, resetAt } = current;
  if (resetAt <= nowMs) return { kind: "none", reason: "the window has reset; no reading of the new one yet" };
  if (points.length < PROJECTION_MIN_SAMPLES) return { kind: "none", reason: "fewer than three readings of this window so far" };
  const basisMs = points[points.length - 1].at - points[0].at;
  if (basisMs < (isWeekly(name) ? WEEKLY_MIN_SPAN_MS : MIN_SPAN_MS)) return { kind: "none", reason: "the readings span too short a time for a rate" };
  const from = points[points.length - 1];
  const rate = Math.max(0, slopePerHour(points));
  const usedAtReset = Math.min(100, from.usedPercent + (rate * (resetAt - from.at)) / 3_600_000);
  const exhaustsMs = rate > 0 && from.usedPercent < 100 ? from.at + ((100 - from.usedPercent) / rate) * 3_600_000 : undefined;
  return {
    kind: "projected",
    ratePerHour: round1(rate),
    usedAtReset: round1(usedAtReset),
    unusedAtReset: round1(100 - usedAtReset),
    ...(exhaustsMs !== undefined && exhaustsMs <= resetAt ? { exhaustsAt: new Date(exhaustsMs).toISOString() } : {}),
    basisMinutes: Math.round(basisMs / 60_000),
  };
}
