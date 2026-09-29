/* The sidebar's Tree view: sessions nested under the session that spawned them
 * (`parentSessionId`). Pure data only, so the awkward shapes the live list can
 * take are testable without rendering the sidebar.
 *
 * The loaded list is never a clean tree. It is a bounded page per employee
 * group, archived sessions are absent, and nothing on the wire stops a bad
 * write from pointing a session at itself or at its own descendant. So:
 *   • a session whose parent is not in the loaded set is a root, marked
 *     `orphan` (the parent is archived, deleted, or simply not loaded yet —
 *     the list cannot tell those apart, and loading more re-nests it);
 *   • a parent in another employee group nests normally — grouping is not
 *     part of the tree;
 *   • a cycle is broken at its most recently active member, which becomes a
 *     root marked `cycle`;
 *   • every walk is iterative, so a very deep chain cannot blow the stack. */

import { getSessionActivity, type Session } from "@/components/chat/session-signals"

/** How a top-level row came to be top-level. `root` has no parent at all. */
export type TreeRootKind = "root" | "orphan" | "cycle"

export interface SessionTreeNode {
  session: Session
  /** Newest first, by each child's own subtree activity. */
  children: SessionTreeNode[]
  /** Every session below this one, at any depth. */
  descendantCount: number
  /** The newest activity anywhere in this subtree, so a busy child keeps its
   *  root near the top of the list. */
  activity: string
  /** Set on roots only. */
  rootKind?: TreeRootKind
}

function parentOf(session: Session): string | null {
  const parent = session.parentSessionId
  if (typeof parent !== "string") return null
  const trimmed = parent.trim()
  return trimmed.length > 0 ? trimmed : null
}

const byActivityDesc = (a: SessionTreeNode, b: SessionTreeNode) => b.activity.localeCompare(a.activity)

function indexSessions(sessions: readonly Session[]): Map<string, SessionTreeNode> {
  const nodes = new Map<string, SessionTreeNode>()
  for (const session of sessions) {
    if (nodes.has(session.id)) continue
    nodes.set(session.id, { session, children: [], descendantCount: 0, activity: getSessionActivity(session) })
  }
  return nodes
}

/** Attach each node to its loaded parent; return the ones with none to attach
 *  to. A self-loop is attached nowhere and left for `breakCycles`. */
function linkParents(nodes: Map<string, SessionTreeNode>): SessionTreeNode[] {
  const roots: SessionTreeNode[] = []
  for (const node of nodes.values()) {
    const parentId = parentOf(node.session)
    if (parentId === node.session.id) continue
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent) {
      parent.children.push(node)
      continue
    }
    node.rootKind = parentId ? "orphan" : "root"
    roots.push(node)
  }
  return roots
}

function markPlaced(start: SessionTreeNode, placed: Set<string>) {
  const stack = [start]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (placed.has(node.session.id)) continue
    placed.add(node.session.id)
    for (const child of node.children) stack.push(child)
  }
}

/** Everything reachable from a root is placed. What is left can only sit on a
 *  cycle, or below one. Each cycle breaks at its newest member, so the root is
 *  one the operator is likely to recognise; a session hanging below a cycle is
 *  not itself cyclic and stays nested under it. */
function breakCycles(nodes: Map<string, SessionTreeNode>, roots: SessionTreeNode[]) {
  const placed = new Set<string>()
  for (const root of roots) markPlaced(root, placed)
  const parentNode = (node: SessionTreeNode) => nodes.get(parentOf(node.session)!)!
  const unplaced = [...nodes.values()].filter((node) => !placed.has(node.session.id)).sort(byActivityDesc)
  for (const start of unplaced) {
    if (placed.has(start.session.id)) continue
    // Climb until a node repeats; the first repeat is on the cycle. Every
    // unplaced node's parent is loaded and unplaced too, or it would have been
    // reached from a root above.
    const seen = new Set<SessionTreeNode>()
    let cursor = start
    while (!seen.has(cursor)) {
      seen.add(cursor)
      cursor = parentNode(cursor)
    }
    let breakAt = cursor
    for (let member = parentNode(cursor); member !== cursor; member = parentNode(member)) {
      if (member.activity > breakAt.activity) breakAt = member
    }
    // Detach it from its parent so every later walk sees an acyclic forest.
    const parent = parentNode(breakAt)
    parent.children = parent.children.filter((child) => child !== breakAt)
    breakAt.rootKind = "cycle"
    roots.push(breakAt)
    markPlaced(breakAt, placed)
  }
}

/** Post-order over the (acyclic) forest: counts, subtree activity and child
 *  order, without recursion. */
function summarise(roots: readonly SessionTreeNode[]) {
  const order: SessionTreeNode[] = []
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()!
    order.push(node)
    for (const child of node.children) stack.push(child)
  }
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i]
    for (const child of node.children) {
      node.descendantCount += 1 + child.descendantCount
      if (child.activity > node.activity) node.activity = child.activity
    }
    node.children.sort(byActivityDesc)
  }
}

/** Build the forest over `sessions`. Duplicate ids keep their first
 *  occurrence; a session naming itself as parent counts as a cycle. */
export function buildSessionForest(sessions: readonly Session[]): SessionTreeNode[] {
  const nodes = indexSessions(sessions)
  const roots = linkParents(nodes)
  breakCycles(nodes, roots)
  summarise(roots)
  return roots.sort(byActivityDesc)
}

export interface SessionTreeRow {
  node: SessionTreeNode
  /** 0 for a root. Uncapped; the row decides how much of it to indent. */
  depth: number
  collapsed: boolean
}

/** The rows a forest renders, depth-first, skipping everything under a
 *  collapsed node. */
export function flattenSessionForest(
  roots: readonly SessionTreeNode[],
  collapsed: ReadonlySet<string>,
): SessionTreeRow[] {
  const rows: SessionTreeRow[] = []
  const stack: Array<{ node: SessionTreeNode; depth: number }> = []
  for (let i = roots.length - 1; i >= 0; i -= 1) stack.push({ node: roots[i], depth: 0 })
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    const isCollapsed = node.children.length > 0 && collapsed.has(node.session.id)
    rows.push({ node, depth, collapsed: isCollapsed })
    if (isCollapsed) continue
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push({ node: node.children[i], depth: depth + 1 })
    }
  }
  return rows
}

/** Every session in a subtree, the node itself included. */
export function subtreeSessions(node: SessionTreeNode): Session[] {
  const out: Session[] = []
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()!
    out.push(current.session)
    for (const child of current.children) stack.push(child)
  }
  return out
}
