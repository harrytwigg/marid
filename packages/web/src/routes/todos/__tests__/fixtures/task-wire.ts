import type { WorkItemCommentWire, WorkItemEventWire, WorkItemRunWire, WorkItemTreeNodeWire } from "@/lib/api"

/* The wire builders the task-page tests share: the feed model and the rendered
 * sections speak in events, comments and run attempts, and the sub-task suites
 * in tree nodes. */

export function event(id: string, kind: string, at: string, extra: Partial<WorkItemEventWire> = {}): WorkItemEventWire {
  return {
    id, workItemId: "PLA-12", kind, fromStatus: null, toStatus: null, actor: "operator",
    detail: null, createdAt: at, ...extra,
  }
}

export function comment(id: string, body: string, at: string, extra: Partial<WorkItemCommentWire> = {}): WorkItemCommentWire {
  return {
    id, workItemId: "PLA-12", parentCommentId: null, authorKind: "employee", author: "mason",
    body, createdAt: at, editedAt: null, deletedAt: null, ...extra,
  }
}

/** A settled attempt by default; an open one is `{ endedAt: null, outcome: null }`. */
export function run(id: string, extra: Partial<WorkItemRunWire> = {}): WorkItemRunWire {
  return {
    id, workItemId: "PLA-12", sessionId: `session-${id}`,
    startedAt: "2026-07-22T08:00:00.000Z", endedAt: "2026-07-22T08:40:00.000Z",
    outcome: "completed", summary: null, handoff: {}, error: null, ...extra,
  }
}

/** A tree node with every wire field filled in — the sub-task suites build
 *  their fixtures on top of it. */
export function workItemNode(id: string, overrides: Partial<WorkItemTreeNodeWire> = {}): WorkItemTreeNodeWire {
  return {
    id,
    version: 1,
    title: `Item ${id}`,
    body: null,
    status: "executing",
    department: null,
    assignee: null,
    priority: 2,
    rank: null,
    source: "human",
    sourceRef: null,

    rounds: 0,
    budgetUsd: null,
    createdBy: "operator",
    parentId: "PLA-12",
    rootId: "PLA-12",
    depth: 1,
    dueAt: null,
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-20T08:00:00.000Z",
    closedAt: null,
    children: [],
    ...overrides,
  }
}
