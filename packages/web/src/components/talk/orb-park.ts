/** The four screen corners the orb can rest in. */
export type ParkCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right"

const CORNERS: readonly ParkCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"]

/** Thumb-side on a phone, out of the way of the composer on a desktop. */
export const DEFAULT_PARK: ParkCorner = "bottom-right"

export const PARK_STORAGE_KEY = "hundredfold-talk-orb-park"

/** The slice of `localStorage` the park position needs — satisfied by test fakes too. */
export type OrbParkStore = Pick<Storage, "getItem" | "setItem">

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

function defaultStore(): OrbParkStore | null {
  return typeof localStorage !== "undefined" ? localStorage : null
}

/**
 * The corner of the quadrant `point` falls in. Points outside the viewport
 * resolve to the corner they overshot, and a point exactly on a midline resolves
 * to the far side, so a release never lands between two answers.
 */
export function nearestCorner(point: Point, viewport: Viewport): ParkCorner {
  const right = point.x >= viewport.width / 2
  if (point.y >= viewport.height / 2) return right ? "bottom-right" : "bottom-left"
  return right ? "top-right" : "top-left"
}

/** The stored corner, or the default one when the value is absent or not a corner. */
export function readPark(store: OrbParkStore | null = defaultStore()): ParkCorner {
  const raw = store?.getItem(PARK_STORAGE_KEY)
  return CORNERS.find((corner) => corner === raw) ?? DEFAULT_PARK
}

export function writePark(corner: ParkCorner, store: OrbParkStore | null = defaultStore()): void {
  store?.setItem(PARK_STORAGE_KEY, corner)
}
