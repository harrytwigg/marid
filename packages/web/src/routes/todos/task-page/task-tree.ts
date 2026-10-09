import type { WorkItemDetailWire, WorkItemTreeNodeWire } from "@/lib/api"
import type { CrumbAncestor } from "./crumb-bar"

/** Walk the root tree to the item: the crumb bar's ancestor trail. */
export function ancestorsOf(root: WorkItemTreeNodeWire | undefined, id: string): CrumbAncestor[] {
  if (!root) return []
  const path: CrumbAncestor[] = []
  const walk = (node: WorkItemTreeNodeWire, trail: CrumbAncestor[]): CrumbAncestor[] | null => {
    if (node.id === id) return trail
    for (const child of node.children ?? []) {
      const found = walk(child, [...trail, { id: node.id, title: node.title }])
      if (found) return found
    }
    return null
  }
  return walk(root, path) ?? []
}

/** Find the item's own node inside the root tree (sub-tasks, roll-ups). */
export function nodeOf(root: WorkItemTreeNodeWire | undefined, id: string): WorkItemTreeNodeWire | undefined {
  if (!root) return undefined
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const found = nodeOf(child, id)
    if (found) return found
  }
  return undefined
}

/** How long the live run has been going, for the chip cluster; null unless executing. */
export function workingElapsed(detail: WorkItemDetailWire): string | null {
  if (detail.workItem.status !== "executing") return null
  let startedAt: string | undefined
  for (let i = detail.events.length - 1; i >= 0; i--) {
    if (detail.events[i].toStatus === "executing") {
      startedAt = detail.events[i].createdAt
      break
    }
  }
  const start = Date.parse(startedAt ?? detail.workItem.updatedAt)
  if (Number.isNaN(start)) return null
  const mins = Math.max(0, Math.round((Date.now() - start) / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
