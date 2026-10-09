import type { WorkItemDetailWire, WorkItemEventWire } from "@/lib/api"

/** Five distinct whispers, oldest first — the order the gateway sends. */
const EVENTS: WorkItemEventWire[] = [
  ["created", "created this todo"],
  ["label_changed", "changed the labels"],
  ["relation_added", "linked a related todo"],
  ["session_linked", "linked a session"],
  ["attachment_removed", "removed an attachment"],
].map(([kind], index) => ({
  id: `e${index + 1}`,
  workItemId: "ICI-1",
  kind,
  fromStatus: null,
  toStatus: null,
  actor: "a-lead",
  detail: null,
  createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
}))

export function detailOf(
  id: string,
  overrides: Partial<WorkItemDetailWire["workItem"]> = {},
): WorkItemDetailWire {
  return {
    workItem: {
      id,
      version: 4,
      title: `Title of ${id}`,
      body: "A body.",
      status: "executing",
      department: null,
      assignee: "a-lead",
      priority: 3,
      rank: null,
      source: "human",
      sourceRef: null,

      rounds: 0,
      budgetUsd: null,
      parentId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      closedAt: null,
      ...overrides,
    },
    spendUsd: 0,
    events: EVENTS,
  }
}
