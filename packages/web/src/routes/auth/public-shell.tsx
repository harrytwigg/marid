import { Suspense, type ReactNode } from "react"
import { ThemeProvider } from "@/routes/providers"
import { BrandMark } from "@/components/brand-mark-image"

/** What shows while an invite or reset page loads. It is the route loading frame without its tab bar: that bar leads
 *  to the operator's pages, and nothing here may reach the gateway before the person has a session. */
function PublicLoading() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-[var(--space-4)] bg-[var(--bg)]" role="status" aria-label="Loading page">
      <BrandMark size={56} className="motion-safe:animate-pulse" />
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
    </div>
  )
}

/** The invite and reset pages sit outside the authenticated shell: the person arriving on one has no
 *  session yet, so nothing that reads the gateway as the operator may mount around them. */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <Suspense fallback={<PublicLoading />}>{children}</Suspense>
    </ThemeProvider>
  )
}
