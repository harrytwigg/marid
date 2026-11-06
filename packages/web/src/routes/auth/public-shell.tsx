import { Suspense, type ReactNode } from "react"
import { ThemeProvider } from "@/routes/providers"
import { RouteLoading } from "@/components/route-loading"

/** The invite and reset pages sit outside the authenticated shell: the person arriving on one has no
 *  session yet, so nothing that reads the gateway as the operator may mount around them. */
export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <Suspense fallback={<RouteLoading />}>{children}</Suspense>
    </ThemeProvider>
  )
}
