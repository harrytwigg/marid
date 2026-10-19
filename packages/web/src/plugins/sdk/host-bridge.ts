/**
 * The two handles the app fills in as it mounts, mirroring
 * `components/talk/tools/router-handle.ts`: a module-level registration is how
 * a caller that is not a React render reaches app machinery, and a plugin's
 * event handler or backend callback is exactly that.
 */

export type HostNavigator = (path: string) => void

/** How loud a notification is; the host decides what each one looks like. */
export type HostNotifyLevel = 'info' | 'warning' | 'error'

/** A notification with more to say than one line: the title carries the event
 *  and the description the detail. `level` defaults to `info`. */
export interface HostNotice {
  title: string
  description?: string
  level?: HostNotifyLevel
}

/** The surface receives the notice with its level already resolved, so it never
 *  has to decide what an absent one meant. */
export type HostNotificationSink = (notice: HostNotice & { level: HostNotifyLevel }) => void

let navigate: HostNavigator | null = null
let notificationSink: HostNotificationSink | null = null

export function registerHostNavigator(fn: HostNavigator): void {
  navigate = fn
}

/** Null until the app has mounted. `host.navigate` reports that rather than
 *  queueing: a plugin navigating this early has a bug, not a race. */
export function hostNavigator(): HostNavigator | null {
  return navigate
}

/** Returns the way to unregister, which does nothing if another surface has registered since. */
export function registerHostNotificationSink(fn: HostNotificationSink): () => void {
  notificationSink = fn
  return () => {
    if (notificationSink === fn) notificationSink = null
  }
}

/** Null until a surface that can show a notification is mounted. */
export function hostNotificationSink(): HostNotificationSink | null {
  return notificationSink
}

/** Test-only: drop both registrations so a suite starts from a known state. */
export function clearHostBridge(): void {
  navigate = null
  notificationSink = null
}
