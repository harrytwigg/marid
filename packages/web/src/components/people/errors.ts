import { AccountsError, describeWait } from "@/lib/accounts-api"

/** What an inline error under an accounts form says. A 429 names the wait the gateway asked for. */
export function accountsErrorText(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (error instanceof AccountsError) {
    if (error.status === 429) {
      return error.retryAfterSeconds ? `Too many attempts. Try again in ${describeWait(error.retryAfterSeconds)}.` : "Too many attempts. Try again shortly."
    }
    return error.message
  }
  return error instanceof Error && error.message ? error.message : fallback
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never"
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? "unknown" : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
