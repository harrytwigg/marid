import { raiseNotice } from "@/lib/notices"

/**
 * What a lazily loaded overlay (a dialog, a sheet, a menu) says when its chunk cannot be fetched, which happens
 * after a deploy leaves a tab holding names that no longer exist, or offline. The person pressed something and got
 * nothing back, so the overlay closes and this says why, once, on the app's notice surface (`Notices`, mounted for
 * every route), in words that name what they asked for and what to do.
 *
 * Without a mounted surface (a test, the first frame) the words go to the console instead of nowhere.
 */
export function loadFailureMessage(what: string): string {
  return `${what} couldn't load. Reload the page and try again.`
}

export function reportLoadFailure(what: string): void {
  raiseNotice({ title: loadFailureMessage(what), level: "error" })
}
