import { lazy, Suspense } from "react"
import { useAuth } from "@/routes/auth-provider"
import { Section } from "../shared"

const PeopleSection = lazy(() => import("./people-section").then((module) => ({ default: module.PeopleSection })))

/** The People section of Settings. It reads only `accountsEnabled`: absent (an older gateway, or no auth state yet)
 *  renders nothing, so an instance that never made an account shows the same Settings page it always did, and the
 *  section's own chunk is not fetched. */
export function PeopleEntry() {
  const accountsEnabled = useAuth().authState?.accountsEnabled
  if (accountsEnabled === undefined) return null
  if (accountsEnabled === false) {
    return (
      <Section title="People">
        <p data-testid="people-needs-auth" className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          People and board sharing need gateway auth. Turn on gateway auth, then come back here to invite people.
        </p>
      </Section>
    )
  }
  return (
    <Suspense fallback={null}>
      <PeopleSection />
    </Suspense>
  )
}
