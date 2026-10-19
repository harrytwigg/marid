import * as React from "react"
import {
  Activity,
  Bell,
  Calendar,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Filter,
  Folder,
  Inbox,
  Info,
  Link,
  ListChecks,
  Mail,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Star,
  Tag,
  Trash2,
  TriangleAlert,
  User,
  Users,
  X,
  Zap,
} from "./icons"
import type { IconComponent } from "./icon-svg"

export * from "./icons"
export type { IconComponent, IconProps } from "./icon-svg"

/**
 * The app's icon set, keyed by name.
 *
 * Name-keyed rather than a component a caller imports, because the caller we
 * added this for is a plugin: the runtime loader's allowlist is the SDK, React
 * and the JSX runtime, so a plugin cannot import an icon library at all. A
 * curated map costs the loader nothing, and it keeps an icon library out of a
 * public contract that a plugin author has no way to install against.
 *
 * Names are the contract — a plugin writes them as strings — so a rename here
 * is a breaking change and an addition is not.
 */
const ICONS = {
  activity: Activity,
  bell: Bell,
  calendar: Calendar,
  check: Check,
  "check-circle": CheckCircle,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  clock: Clock,
  "external-link": ExternalLink,
  file: FileText,
  filter: Filter,
  folder: Folder,
  inbox: Inbox,
  info: Info,
  link: Link,
  list: ListChecks,
  mail: Mail,
  message: MessageSquare,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  trash: Trash2,
  user: User,
  users: Users,
  warning: TriangleAlert,
  x: X,
  zap: Zap,
} as const satisfies Record<string, IconComponent>

export type IconName = keyof typeof ICONS

export { ICONS }

/** The icon a name maps to, or `undefined` when the set has no such name. The
 *  caller decides what an unknown name falls back to. */
export function lookupIcon(name: string): IconComponent | undefined {
  return (ICONS as Record<string, IconComponent>)[name]
}

interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "name" | "ref"> {
  name: IconName
  size?: number | string
}

function Icon({ name, size = 16, ...props }: IconProps) {
  const Glyph = lookupIcon(name)
  if (!Glyph) {
    // A disk plugin is plain JS, so a misspelled name arrives here rather than
    // failing to typecheck. Naming the set beats an invisible hole in a row.
    console.warn(
      `[plugin-sdk] no icon named ${JSON.stringify(name)}; the set is ${Object.keys(ICONS).join(", ")}`,
    )
    return null
  }

  return <Glyph data-slot="icon" size={size} aria-hidden {...props} />
}

export { Icon }
