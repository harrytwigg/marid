/**
 * How the app tells the person something no screen of its own is showing: a
 * lazy dialog that would not load, a failure with no place on the page. The
 * surface (`components/ui/notices.tsx`, mounted once for every route)
 * registers here as it mounts, mirroring `plugins/sdk/host-bridge.ts`: the
 * callers are event handlers and promise rejections, not renders, so a
 * module-level registration is how they reach it.
 *
 * Plugins reach the same surface through `host.notify`, which keeps its own
 * seam in the SDK; the surface registers on both and tags where each came
 * from, so a plugin in a loop can crowd out other plugin notices but never
 * an app one.
 */

/** How loud a notice is. Info stays on the neutral text ramp, the others take a status dot. */
export type NoticeLevel = "info" | "warning" | "error"

export interface AppNotice {
  title: string
  description?: string
  level?: NoticeLevel
}

/** The surface receives the notice with its level already resolved. */
export type NoticeSink = (notice: AppNotice & { level: NoticeLevel }) => void

let sink: NoticeSink | null = null

/** Returns the way to unregister, which does nothing if another surface has registered since. */
export function registerNoticeSink(fn: NoticeSink): () => void {
  sink = fn
  return () => {
    if (sink === fn) sink = null
  }
}

/** Raise a notice on the app's surface. With none mounted (a test, the first frame) the words go to the console instead of nowhere. */
export function raiseNotice(notice: AppNotice): void {
  const resolved = { ...notice, level: notice.level ?? "info" }
  if (sink) sink(resolved)
  else console.warn(`[notice] ${resolved.level}: ${resolved.title}`)
}

/** Test-only: drop the registration so a suite starts from a known state. */
export function clearNoticeSink(): void {
  sink = null
}
