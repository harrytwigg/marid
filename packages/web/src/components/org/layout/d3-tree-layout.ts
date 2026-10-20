import { stratify, tree } from "d3-hierarchy"
import type { Node, Edge } from "@xyflow/react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import { NODE_W, NODE_H } from "./constants"
export { NODE_W, NODE_H } from "./constants"

// Tidy-tree spacing within a department subtree.
const H_GAP = 28 // between sibling nodes
const V_GAP = 60 // between hierarchy levels

// Department container padding.
const GROUP_PAD_X = 16
const GROUP_PAD_TOP = 34
const GROUP_PAD_BOTTOM = 18

// Shelf-packing of department blocks.
const BLOCK_GAP = 32 // horizontal gap between department blocks in a row
const ROW_GAP = 40 // vertical gap between rows of blocks
const COO_ROW_GAP = 56 // gap below the COO node before the department rows
const MIN_TARGET_W = 2200 // target row width the packer wraps at

// Inter-department routes. A COO -> root edge drawn directly crosses every
// block stacked between them once the packer wraps to a second row, so rows
// below the first are reached through a margin lane and the clear band above
// their own row. The margin is reserved on both sides so a lane never runs
// through a block, and the trunk is the shared band under the COO.
const LANE_PAD = 56 // margin reserved outside the packed blocks
const LANE_INSET = 16 // distance from the canvas edge to a route lane
const TRUNK_Y = NODE_H + 16 // shared horizontal band below the COO node

export interface LayoutResult {
  nodes: Node[]
  edges: Edge[]
}

interface Point {
  x: number
  y: number
}

interface TreeDatum {
  name: string
  parent: string | null
}

interface DeptBlock {
  dept: string
  rootNames: string[] // real roots (top nodes) — COO connects to these
  local: Map<string, { x: number; y: number }> // node top-left within the block
  w: number
  h: number
  x: number // assigned canvas offset
  y: number
}

const SYNTH_ROOT = "__deptroot__"

// Lay a single department's members as a tidy subtree; return local node
// positions (top-left, origin inside the block) plus the block's size + roots.
function buildDeptBlock(dept: string, members: Employee[]): DeptBlock {
  const set = new Set(members.map((m) => m.name))
  const data: TreeDatum[] = members.map((m) => ({
    name: m.name,
    parent: m.parentName && set.has(m.parentName) ? m.parentName : null,
  }))
  const rootNames = data.filter((d) => !d.parent).map((d) => d.name)
  // Multiple in-department roots: parent them to a synthetic hidden root so the
  // tidy layout still works; the synthetic node is excluded from output.
  if (rootNames.length !== 1) {
    for (const d of data) if (!d.parent) d.parent = SYNTH_ROOT
    data.push({ name: SYNTH_ROOT, parent: null })
  }

  const root = stratify<TreeDatum>()
    .id((d) => d.name)
    .parentId((d) => d.parent)(data)
  const layout = tree<TreeDatum>()
    .nodeSize([NODE_W + H_GAP, NODE_H + V_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.15))
  const positioned = layout(root)

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const raw = new Map<string, { x: number; y: number }>()
  positioned.each((n) => {
    if (n.data.name === SYNTH_ROOT) return
    raw.set(n.data.name, { x: n.x, y: n.y })
    minX = Math.min(minX, n.x)
    maxX = Math.max(maxX, n.x)
    minY = Math.min(minY, n.y)
    maxY = Math.max(maxY, n.y)
  })

  // Convert d3 centers to block-local TOP-LEFT: leftmost/topmost node sits at
  // (GROUP_PAD_X, GROUP_PAD_TOP); sibling spacing is preserved (NODE_W + H_GAP).
  const local = new Map<string, { x: number; y: number }>()
  for (const [name, p] of raw) {
    local.set(name, {
      x: p.x - minX + GROUP_PAD_X,
      y: p.y - minY + GROUP_PAD_TOP,
    })
  }
  const w = maxX - minX + NODE_W + GROUP_PAD_X * 2
  const h = maxY - minY + NODE_H + GROUP_PAD_TOP + GROUP_PAD_BOTTOM
  return { dept, rootNames, local, w, h, x: 0, y: 0 }
}

function dedupePoints(points: Point[]): Point[] {
  return points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y,
  )
}

interface RouteLanes {
  left: number
  right: number
  firstRowY: number
}

/**
 * Route a COO -> department-root edge. Block-local roots sit at the top of
 * their block, so the edge may enter from above; it just may not cross another
 * block or card on the way there.
 *
 * First row: fan out in the clear band below the COO, above every block.
 * Later rows: drop down a margin lane to the band above the target's row, then
 * run across that band to the root's column. Both bands are outside every
 * department box by construction, so the route never has to negotiate a card.
 */
function routeToRoot(
  coo: Point,
  target: Point,
  block: DeptBlock,
  lanes: RouteLanes,
): Point[] {
  const head: Point[] = [coo, { x: coo.x, y: TRUNK_Y }]
  if (block.y <= lanes.firstRowY) {
    return dedupePoints([...head, { x: target.x, y: TRUNK_Y }, target])
  }
  const laneX = target.x < coo.x ? lanes.left : lanes.right
  const rowGapY = block.y - ROW_GAP / 2
  return dedupePoints([
    ...head,
    { x: laneX, y: TRUNK_Y },
    { x: laneX, y: rowGapY },
    { x: target.x, y: rowGapY },
    target,
  ])
}

/**
 * Compact org layout: COO anchored on top, each department laid as its own
 * tidy subtree, department blocks shelf-packed into balanced rows. Keeps a
 * flat 19-department org to a ~2:1 canvas instead of the ~20:1 ribbon a single
 * global tidy-tree produces.
 *
 * Throws if the employee set is not a single-rooted tree (caller falls back to
 * the dagre layout).
 */
export function buildTreeLayout(
  employees: Employee[],
  hierarchy: OrgHierarchy,
  selectedName: string | null,
): LayoutResult {
  if (employees.length === 0) return { nodes: [], edges: [] }

  const executive = employees.find((e) => e.rank === "executive")
  const empByName = new Map(employees.map((e) => [e.name, e]))

  // ── Integrity guard: validate a single global root; throw → dagre fallback ──
  const nodeIds = [...hierarchy.sorted]
  if (executive && !nodeIds.includes(executive.name)) nodeIds.unshift(executive.name)
  const idSet = new Set(nodeIds)
  const globalData: TreeDatum[] = nodeIds.map((name) => {
    const emp = empByName.get(name)
    if (!emp) return { name, parent: executive?.name ?? null }
    if (emp.rank === "executive") return { name, parent: null }
    const p = emp.parentName && idSet.has(emp.parentName) ? emp.parentName : null
    return { name, parent: p ?? executive?.name ?? null }
  })
  stratify<TreeDatum>().id((d) => d.name).parentId((d) => d.parent)(globalData)

  // ── Build a tidy block per department (executive excluded) ──
  const deptMembers = new Map<string, Employee[]>()
  for (const name of nodeIds) {
    const emp = empByName.get(name)
    if (!emp || emp.rank === "executive" || !emp.department) continue
    const list = deptMembers.get(emp.department) ?? []
    list.push(emp)
    deptMembers.set(emp.department, list)
  }
  const blocks = [...deptMembers.entries()]
    .map(([dept, members]) => buildDeptBlock(dept, members))
    .sort((a, b) => b.h - a.h) // tallest first → tidy shelves

  // ── Shelf-pack blocks into rows ──
  const widest = blocks.reduce((m, b) => Math.max(m, b.w), 0)
  const targetW = Math.max(widest, MIN_TARGET_W)
  interface Row { blocks: DeptBlock[]; w: number; h: number }
  const rows: Row[] = []
  let row: Row = { blocks: [], w: 0, h: 0 }
  for (const b of blocks) {
    if (row.blocks.length > 0 && row.w + b.w > targetW) {
      rows.push(row)
      row = { blocks: [], w: 0, h: 0 }
    }
    b.x = row.w
    row.blocks.push(b)
    row.w += b.w + BLOCK_GAP
    row.h = Math.max(row.h, b.h)
  }
  if (row.blocks.length > 0) rows.push(row)

  const packedW = rows.reduce((m, r) => Math.max(m, r.w - BLOCK_GAP), 0)
  const canvasW = packedW + LANE_PAD * 2
  const deptTop = NODE_H + COO_ROW_GAP

  // Assign final canvas coords: center each row horizontally inside the
  // margin-reserved canvas, stack rows.
  let cursorY = deptTop
  for (const r of rows) {
    const rowW = r.w - BLOCK_GAP
    const offsetX = (packedW - rowW) / 2 + LANE_PAD
    for (const b of r.blocks) {
      b.x += offsetX
      b.y = cursorY
    }
    cursorY += r.h + ROW_GAP
  }

  // ── Highlight chain ──
  const highlighted = new Set<string>()
  if (selectedName) {
    const sel = empByName.get(selectedName)
    if (sel?.chain) for (const n of sel.chain) highlighted.add(n)
    const addDesc = (name: string) => {
      highlighted.add(name)
      const e = empByName.get(name)
      if (e?.directReports) for (const c of e.directReports) addDesc(c)
    }
    addDesc(selectedName)
  }

  // ── Emit nodes (group boxes first so they render behind) ──
  const rfNodes: Node[] = []
  for (const b of blocks) {
    rfNodes.push({
      id: `group-${b.dept}`,
      type: "departmentGroup",
      data: { label: b.dept },
      position: { x: b.x, y: b.y },
      style: { width: b.w, height: b.h, padding: 0 },
      selectable: false,
      draggable: false,
    })
  }

  // Employee nodes — block-local positions are already top-left.
  for (const b of blocks) {
    for (const [name, lp] of b.local) {
      const pos = { x: b.x + lp.x, y: b.y + lp.y }
      const emp = empByName.get(name)
      if (!emp) continue
      rfNodes.push({
        id: name,
        type: "employeeNode",
        data: emp as unknown as Record<string, unknown>,
        position: pos,
        selected: name === selectedName,
      })
    }
  }

  // COO node — centered over the whole canvas, on top.
  if (executive) {
    rfNodes.push({
      id: executive.name,
      type: "employeeNode",
      data: executive as unknown as Record<string, unknown>,
      position: { x: canvasW / 2 - NODE_W / 2, y: 0 },
      selected: executive.name === selectedName,
    })
  }

  // ── Edges ──
  const rfEdges: Edge[] = []
  const pushEdge = (source: string, target: string, points?: Point[]) => {
    const hi = highlighted.has(source) && highlighted.has(target)
    rfEdges.push({
      id: `${source}-${target}`,
      source,
      target,
      type: points ? "orgRoute" : "smoothstep",
      data: points ? { highlighted: hi, points } : { highlighted: hi },
    })
  }
  const lanes: RouteLanes = {
    left: LANE_INSET,
    right: canvasW - LANE_INSET,
    firstRowY: deptTop,
  }
  const cooPoint = { x: canvasW / 2, y: NODE_H }
  // within-department parent -> child
  for (const b of blocks) {
    const members = deptMembers.get(b.dept) ?? []
    const set = new Set(members.map((m) => m.name))
    for (const m of members) {
      if (m.parentName && set.has(m.parentName)) pushEdge(m.parentName, m.name)
    }
    if (!executive) continue
    // COO -> each department root, routed clear of every block between them.
    for (const r of b.rootNames) {
      const lp = b.local.get(r)
      if (!lp) continue
      const target = { x: b.x + lp.x + NODE_W / 2, y: b.y + lp.y }
      pushEdge(executive.name, r, routeToRoot(cooPoint, target, b, lanes))
    }
  }

  return { nodes: rfNodes, edges: rfEdges }
}
