/** The closed semantic vocabulary shared by route parsing and live Talk context. */
export type PageKind =
  | "chat"
  | "todos"
  | "todo"
  | "org"
  | "projects"
  | "cron"
  | "notes"
  | "logs"
  | "limits"
  | "auto-dispatch"
  | "settings"
  | "settings-plugins"
  | "skills"
  | "skill"
  | "file"
  | "more"
  | "talk-orb"
  | "redesign"
  | "plugin"
  | "other"

export interface PageSelection {
  kind: string
  id: string
}

export interface PageSnapshot {
  kind: PageKind
  path: string
  params: Readonly<Record<string, string>>
  filters: Readonly<Record<string, string>>
  selection: PageSelection | null
}

export interface SemanticRelation {
  kind: string
  id: string
  title: string
  status?: string
}

export interface SemanticObject {
  kind: string
  id: string
  title: string
  status?: string
  fields: Readonly<Record<string, unknown>>
  relations: readonly SemanticRelation[]
  retrievalAnchor: Readonly<Record<string, string | number>>
}

export interface SemanticVisibleItem {
  id: string
  title: string
  status?: string
  relation?: string
}

export interface SemanticControl {
  label: string
  operation: string
  target?: string
}

/** The versioned, live semantic contract sent to Talk. */
export interface TalkScreenContext extends PageSnapshot {
  version: 1
  revision: number
  routeId: string
  capturedAt: string
  freshness: "complete" | "partial" | "stale"
  missing: readonly string[]
  title: string
  selectedObject: SemanticObject | null
  visibleItems: readonly SemanticVisibleItem[]
  controls: readonly SemanticControl[]
  meaningfulText: string
  browserInstanceId: string
  focus: { tag: string; label: string } | null
  hidden: boolean
  /** Evidence absent from structured context that can justify one image. */
  visualGaps: readonly string[]
}
