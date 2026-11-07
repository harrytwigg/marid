import { Suspense } from "react"
import { SettingsProvider, DocumentTitle } from "@/routes/settings-provider"
import { GatewayProvider } from "@/hooks/use-gateway"
import { QueryInvalidationBridge, TodoMentionPrefixes } from "@/routes/client-providers"
import { Notices } from "@/components/ui/notices"
import { RouteLoading } from "@/components/route-loading"
import { MemberRoutes } from "./member-routes"

/** A board member's app. Only what the shared board and Todo surfaces need to run: settings (their
 *  display preferences), the live socket (which the gateway filters to their boards) and the cache
 *  bridge that turns its frames into refetches. No plugins, no Talk, no operator chrome. */
export default function MemberRoot() {
  return (
    <SettingsProvider>
      <GatewayProvider>
        <TodoMentionPrefixes>
          <Suspense fallback={<RouteLoading />}>
            <MemberRoutes />
          </Suspense>
        </TodoMentionPrefixes>
        <DocumentTitle />
        <QueryInvalidationBridge />
        <Notices />
      </GatewayProvider>
    </SettingsProvider>
  )
}
