import {
  MessageSquare, Users, ListChecks, Clock,
  Activity, Zap, Settings, Gauge, NotebookPen, Rocket,
} from "lucide-react"

// Every top-level destination, so the command palette can reach anything the
// mobile tab bar / More overflow reaches (kept in step with lib/nav NAV_ITEMS).
// The overlay itself searches pages through the gateway now; this list is what
// the navigation suites hold the palette's reach against.
const BASE_STATIC_PAGES = [
  { id: "page-chat", label: "Chat", icon: MessageSquare, href: "/" },
  { id: "page-todos", label: "Todos", icon: ListChecks, href: "/todos" },
  { id: "page-org", label: "Organization", icon: Users, href: "/org" },
  { id: "page-cron", label: "Cron", icon: Clock, href: "/cron" },
  { id: "page-limits", label: "Limits", icon: Gauge, href: "/limits" },
  { id: "page-auto-dispatch", label: "Auto-Dispatch", icon: Rocket, href: "/auto-dispatch" },
  { id: "page-logs", label: "Activity", icon: Activity, href: "/logs" },
  { id: "page-skills", label: "Skills", icon: Zap, href: "/skills" },
  { id: "page-settings", label: "Settings", icon: Settings, href: "/settings" },
]

export function staticPagesFor(notesEnabled: boolean) {
  const notesPage = { id: "page-notes", label: "Notes", icon: NotebookPen, href: "/notes" }
  return notesEnabled
    ? [...BASE_STATIC_PAGES.slice(0, 2), notesPage, ...BASE_STATIC_PAGES.slice(2)]
    : BASE_STATIC_PAGES
}

export const STATIC_PAGES = staticPagesFor(false)
