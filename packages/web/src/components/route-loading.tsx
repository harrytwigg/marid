import { useRouteLoadingPresence } from '@/components/chat/chat-hydration'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import { BrandMark } from '@/components/brand-mark-image'

/**
 * The route-level Suspense fallback. It MUST carry the mobile tab bar: routes
 * are code-split and each page mounts its own MobileTabBar, so on a cold tab
 * switch this fallback is the committed frame between two pages. Without the
 * bar here, that frame has no `jinn-tab-bar` view-transition element — the
 * bar's old snapshot plays an exit fade and the chat list shows through where
 * the bar was (the mobile "nav briefly disappears" bug). With it, the
 * view-transition pairs old and new bars and the nav holds still through the
 * chunk load. Desktop is unaffected (the bar is lg:hidden).
 *
 * It sits on the flat sheet colour with the glass mark, so the frame between
 * the first paint and the page does not change the surface, whatever the
 * transparency setting.
 */
export function RouteLoading({ label = 'Loading page' }: { label?: string }) {
  useRouteLoadingPresence()
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-[var(--space-4)] bg-[var(--bg)]" role="status" aria-label={label}>
      <BrandMark size={56} className="motion-safe:animate-pulse" />
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
      <MobileTabBar />
    </div>
  )
}
