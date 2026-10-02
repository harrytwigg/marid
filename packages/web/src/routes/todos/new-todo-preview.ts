import type { WorkItemDetailWire, WorkItemLabelWire } from "@/lib/api"

/* The stand-in record the create dialog previews itself with. It is not a Todo
 * and never reaches the gateway — it exists so the dialog can render the same
 * property rail a real Todo gets, from a draft that has no id yet. */

export function createDetail({
  title,
  department,
  assignee,
  priority,
  dueAt,
  labels,
}: {
  title: string
  department: string | null
  assignee: string | null
  priority: number
  dueAt: string | null
  labels: WorkItemLabelWire[]
}): WorkItemDetailWire {
  const now = new Date().toISOString()
  return {
    workItem: {
      id: "NEW-0",
      version: 1,
      title,
      body: null,
      status: "backlog",
      department,
      assignee,
      priority,
      rank: null,
      source: "human",
      sourceRef: null,
      acceptance: null,
      verifyPolicy: null,
      rounds: 0,
      budgetUsd: null,
      dueAt,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    },
    labels,
    spendUsd: 0,
    events: [],
  }
}
