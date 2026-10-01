import { queryClient } from "@/lib/query-client"
import { matchAppRoute } from "@/lib/app-routes"
import { visibleObjects } from "./visible-objects"
import { liveChatObject } from "./live-chat-packet"
import {
  collectControls,
  collectMeaningfulText,
  collectVisualGaps,
  describeFocus,
} from "./dom-semantics"
import type {
  PageSnapshot,
  SemanticObject,
  SemanticRelation,
  TalkScreenContext,
} from "./page-snapshot"

interface BuildScreenContextInput {
  location: PageSnapshot
  browserInstanceId: string
  root: HTMLElement
  capturedAt?: string
  revision?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function safeText(value: unknown): string {
  return text(value)
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(password|secret|api[-_ ]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

function todoRelations(detail: Record<string, unknown>, id: string): SemanticRelation[] {
  const relations: SemanticRelation[] = (Array.isArray(detail.relations) ? detail.relations : []).flatMap((raw) => {
    const relation = record(raw)
    const other = record(relation?.other)
    const relatedId = text(other?.id)
    return relation && other && relatedId
      ? [{ kind: text(relation.kind), id: relatedId, title: text(other.title), status: text(other.status) || undefined }]
      : []
  })
  const linkedSessions = queryClient.getQueryData(["work-item-sessions", id])
  if (!Array.isArray(linkedSessions)) return relations
  for (const raw of linkedSessions) {
    const session = record(raw)
    const sessionId = text(session?.id)
    if (sessionId) relations.push({
      kind: "session",
      id: sessionId,
      title: text(session?.title) || sessionId,
      status: text(session?.status) || undefined,
    })
  }
  return relations
}

function todoFields(item: Record<string, unknown>, detail: Record<string, unknown>): Record<string, unknown> {
  const events = Array.isArray(detail.events) ? detail.events : []
  const blocking = [...events].reverse().map(record).find((event) => event?.toStatus === "blocked")
  const blockingDetail = record(blocking?.detail)
  return Object.fromEntries(Object.entries({
    body: safeText(item.body),
    assignee: text(item.assignee) || null,
    department: text(item.department) || null,
    priority: number(item.priority),
    sourceRef: safeText(item.sourceRef),
    blockedReason: safeText(blockingDetail?.note),
    blockKind: text(blockingDetail?.blockKind),
  }).filter(([, value]) => value !== "" && value !== undefined))
}

function selectedTodo(id: string): SemanticObject | null {
  const detail = record(queryClient.getQueryData(["work-item", id]))
  const item = record(detail?.workItem)
  if (!detail || !item) return null
  return {
    kind: "Todo",
    id,
    title: text(item.title) || id,
    status: text(item.status) || undefined,
    fields: todoFields(item, detail),
    relations: todoRelations(detail, id),
    retrievalAnchor: { kind: "work-item", id, ...(number(item.version) ? { version: number(item.version)! } : {}) },
  }
}

function selectedWorkflowRun(snapshot: PageSnapshot, definition: Record<string, unknown> | null): SemanticObject | null {
  const workflowId = snapshot.params.workflow
  const runId = snapshot.selection?.id
  if (!workflowId || !runId) return null
  const run = record(queryClient.getQueryData(["workflows", "runs", workflowId, runId]))
  if (!run) return null
  const current = record(run.currentOrFailingNode)
  const titles = [text(run.workflowTitle), text(definition?.title), runId]
  return {
    kind: "workflow run",
    id: runId,
    title: titles.find(Boolean) ?? runId,
    status: text(run.status),
    fields: { workflowId, currentNode: text(current?.nodeId), revision: number(run.revision) },
    relations: [],
    retrievalAnchor: { kind: "workflow-run", id: runId, workflowId },
  }
}

function selectedWorkflowDefinition(workflowId: string, definition: Record<string, unknown>): SemanticObject {
  const revision = number(definition.revision)
  return {
    kind: "workflow",
    id: workflowId,
    title: text(definition.title) || workflowId,
    status: definition.enabled === true ? "enabled" : definition.enabled === false ? "disabled" : undefined,
    fields: {
      description: safeText(definition.description),
      nodeCount: Array.isArray(definition.nodes) ? definition.nodes.length : 0,
      edgeCount: Array.isArray(definition.edges) ? definition.edges.length : 0,
    },
    relations: [],
    retrievalAnchor: { kind: "workflow", id: workflowId, ...(revision ? { revision } : {}) },
  }
}

function selectedWorkflow(snapshot: PageSnapshot): SemanticObject | null {
  const workflowId = snapshot.params.workflow ?? (snapshot.kind === "workflow" ? snapshot.selection?.id : undefined)
  if (!workflowId) return null
  const definition = record(queryClient.getQueryData(["workflows", "definition", workflowId]))
  if (snapshot.kind === "workflow-run") return selectedWorkflowRun(snapshot, definition)
  if (!definition) return null
  return selectedWorkflowDefinition(workflowId, definition)
}

function envelope(key: readonly unknown[], field: string): Record<string, unknown> | null {
  const value = record(queryClient.getQueryData(key))
  return record(value?.[field]) ?? value
}

type GenericSourceReader = (id: string) => Record<string, unknown> | null

const GENERIC_SOURCE_READERS: Partial<Record<PageSnapshot["kind"], GenericSourceReader>> = {
  chat: (id) => envelope(["sessions", id], "session"),
  notes: (id) => envelope(["note", id], "note"),
  skill: (id) => envelope(["skill", id], "skill"),
  org: (id) => {
    const org = record(queryClient.getQueryData(["org"]))
    return (Array.isArray(org?.employees) ? org.employees : []).map(record).find((employee) => employee?.name === id) ?? null
  },
  cron: (id) => {
    const jobs = queryClient.getQueryData(["cron-jobs"])
    return (Array.isArray(jobs) ? jobs : []).map(record).find((job) => job?.id === id) ?? null
  },
}

function genericSource(snapshot: PageSnapshot, id: string): Record<string, unknown> | null {
  return GENERIC_SOURCE_READERS[snapshot.kind]?.(id) ?? null
}

function genericSelected(snapshot: PageSnapshot): SemanticObject | null {
  const selection = snapshot.selection
  if (!selection) return null
  const source = genericSource(snapshot, selection.id)
  if (!source) return null
  const anchorKind = snapshot.kind === "chat" ? "session" : selection.kind.toLowerCase().replaceAll(" ", "-")
  const title = text(source.title) || text(source.name) || text(source.displayName) || selection.id
  return {
    kind: selection.kind,
    id: selection.id,
    title,
    status: text(source.status) || undefined,
    fields: {},
    relations: [],
    retrievalAnchor: { kind: anchorKind, id: selection.id, ...(number(source.version) ? { version: number(source.version)! } : {}) },
  }
}

function resolveSelected(snapshot: PageSnapshot, capturedAt: string): SemanticObject | null {
  if (!snapshot.selection) return null
  if (snapshot.kind === "chat" && snapshot.selection.kind === "chat session") {
    return liveChatObject(snapshot.selection.id, capturedAt)
  }
  if (snapshot.kind === "todo") return selectedTodo(snapshot.selection.id)
  if (snapshot.kind === "workflow" || snapshot.kind === "workflow-run") return selectedWorkflow(snapshot)
  return genericSelected(snapshot)
}

function missingContext(routeId: string | undefined, selected: PageSnapshot["selection"], object: SemanticObject | null, gaps: readonly string[]): string[] {
  return [...new Set([
    ...(selected && !object ? ["selected-object"] : []),
    ...(routeId === "plugin-contributed" ? ["plugin-sdk-context"] : []),
    ...gaps,
  ])]
}

function screenTitle(object: SemanticObject | null, root: HTMLElement, routeSurface: string | undefined, kind: string): string {
  return [object?.title, root.querySelector("h1, h2")?.textContent?.trim(), routeSurface, kind]
    .find((value): value is string => Boolean(value)) ?? kind
}

export function buildScreenContext(input: BuildScreenContextInput): TalkScreenContext {
  const route = matchAppRoute(input.location.path)
  const capturedAt = input.capturedAt ?? new Date().toISOString()
  const selectedObject = resolveSelected(input.location, capturedAt)
  const gaps = collectVisualGaps(input.root)
  const missing = missingContext(route?.id, input.location.selection, selectedObject, gaps)
  const title = screenTitle(selectedObject, input.root, route?.surface, input.location.kind)
  const routeId = route?.id ?? "plugin-contributed"
  const selectedChat = input.location.selection?.kind === "chat session"
  return {
    ...input.location,
    version: 1,
    revision: input.revision ?? 0,
    routeId,
    capturedAt,
    freshness: missing.length === 0 ? "complete" : "partial",
    missing,
    title,
    selectedObject,
    visibleItems: visibleObjects(input.location),
    controls: collectControls(input.root),
    meaningfulText: selectedChat ? "" : collectMeaningfulText(input.root),
    browserInstanceId: input.browserInstanceId,
    focus: describeFocus(input.root),
    hidden: document.visibilityState === "hidden",
    visualGaps: gaps,
  }
}
