
import { lazy, Suspense, type ReactNode } from "react"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/query-client'
import { ThemeProvider } from "@/routes/providers"
import { SettingsProvider, DocumentTitle, useSettings } from "@/routes/settings-provider"
import { useQueryInvalidation } from '@/hooks/use-query-invalidation'
import { BrandFavicon } from '@/components/brand-favicon'
import { GatewayProvider } from '@/hooks/use-gateway'
import { AuthGate, AuthProvider, useAuth } from "@/routes/auth-provider"
import { RouteLoading } from "@/components/route-loading"
import { TalkOrbOverlay } from "@/components/talk/talk-orb-overlay"
import { TodoPrefixContext } from "@/components/chat/todo-prefix-context"
import { useTodoPrefixes } from "@/hooks/use-todo-prefixes"
import { Notices } from "@/components/ui/notices"
import { PluginHostBridge } from "@/plugins/sdk/plugin-host-bridge"
import { DiskPluginsBridge } from "@/plugins/disk-plugins-bridge"

// A board member's whole app, loaded only for one: the operator's bundle never carries it.
const MemberRoot = lazy(() => import("@/routes/member/member-root"))

const TalkContextBridge = lazy(() =>
  import("@/components/talk/context/talk-context-bridge").then((module) => ({
    default: module.TalkContextBridge,
  })),
)

export function QueryInvalidationBridge() {
  useQueryInvalidation()
  return null
}

/** Off the first paint: the semantic snapshot exists for the Talk session, and
 *  Talk is off until the operator asks for it. Same gate as TalkOrbOverlay. */
function DeferredTalkContextBridge() {
  const { settings } = useSettings()
  if (!settings.talkOrb) return null
  return (
    <Suspense fallback={null}>
      <TalkContextBridge />
    </Suspense>
  )
}

/** Which 3-letter prefixes name a live board, app-wide: a Todo id reads as a
 *  mention in a chat message, a Todo body, and a comment alike, so the answer
 *  cannot belong to one route. */
export function TodoMentionPrefixes({ children }: { children: ReactNode }) {
  const prefixes = useTodoPrefixes()
  return <TodoPrefixContext.Provider value={prefixes}>{children}</TodoPrefixContext.Provider>
}

function OperatorProviders({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <GatewayProvider>
        <TodoMentionPrefixes>{children}</TodoMentionPrefixes>
        <DeferredTalkContextBridge />
        {/* Above the router, so route changes never remount the orb. */}
        <TalkOrbOverlay />
        <DocumentTitle />
        <BrandFavicon />
        <QueryInvalidationBridge />
        {/* Before the host bridge, so the sink is registered by the
            time a frame can route into it. */}
        <Notices />
        <PluginHostBridge />
        {/* After the host bridge: a plugin's module body may read
            host state the moment it evaluates. */}
        <DiskPluginsBridge />
      </GatewayProvider>
    </SettingsProvider>
  )
}

/** A signed-in board member gets their own app, not the operator's routes under a different guard:
 *  nothing of the operator's shell (its nav, plugins, Talk, settings) is mounted for them. */
function SignedIn({ children }: { children: ReactNode }) {
  const { principal } = useAuth()
  if (principal?.kind === "member") {
    return (
      <Suspense fallback={<RouteLoading />}>
        <MemberRoot />
      </Suspense>
    )
  }
  return <OperatorProviders>{children}</OperatorProviders>
}

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <AuthGate>
            <SignedIn>{children}</SignedIn>
          </AuthGate>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
