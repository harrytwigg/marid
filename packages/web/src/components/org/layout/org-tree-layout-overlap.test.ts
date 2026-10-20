import { describe, expect, it } from "vitest"
import { getSmoothStepPath } from "@xyflow/react"
import { buildTreeLayout, NODE_H, NODE_W } from "./d3-tree-layout"
import type { Employee, OrgHierarchy } from "@/lib/api"

/* A department with several managers and a child tier, a second department,
 * and a system row. This is the shape the org map used to draw edges across:
 * once shelf-packing wrapped to a second row, a COO -> root edge took the
 * direct path through every block in between. */

function emp(partial: Partial<Employee> & { name: string }): Employee {
  return {
    displayName: partial.name,
    department: "",
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "x",
    ...partial,
  } as Employee
}

function fixture(): { employees: Employee[]; hierarchy: OrgHierarchy } {
  const employees: Employee[] = [emp({ name: "coo", rank: "executive" })]
  const sorted: string[] = []
  const add = (e: Employee) => {
    employees.push(e)
    sorted.push(e.name)
  }

  for (let i = 1; i <= 4; i++) {
    const manager = `ops-lead-${i}`
    add(emp({ name: manager, rank: "manager", department: "operations" }))
    const reports = i === 3 ? 1 : 2
    for (let j = 1; j <= reports; j++) {
      add(
        emp({
          name: `ops-${i}-${j}`,
          rank: "employee",
          department: "operations",
          parentName: manager,
        }),
      )
    }
  }

  add(emp({ name: "research-lead", rank: "manager", department: "research" }))
  add(emp({ name: "researcher-1", rank: "employee", department: "research", parentName: "research-lead" }))
  add(emp({ name: "researcher-2", rank: "employee", department: "research", parentName: "research-lead" }))

  add(emp({ name: "platform-lead", rank: "manager", department: "platform" }))
  add(emp({ name: "platform-engineer", rank: "employee", department: "platform", parentName: "platform-lead" }))

  add(emp({ name: "system-admin", rank: "employee", department: "system", system: true }))

  return { employees, hierarchy: { root: "coo", sorted, warnings: [] } }
}

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

interface Point {
  x: number
  y: number
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  return maxX > r.x && minX < r.x + r.w && maxY > r.y && minY < r.y + r.h
}

function expectSegmentClear(
  edge: { id: string; source: string; target: string },
  segment: [Point, Point],
  employeeNodes: Rect[],
  boxes: Rect[],
  departmentOf: Map<string, string>,
) {
  for (const node of employeeNodes) {
    if (node.id === edge.source || node.id === edge.target) continue
    expect(
      segmentHitsRect(segment[0], segment[1], node),
      `${edge.id} passes through ${node.id}`,
    ).toBe(false)
  }
  for (const box of boxes) {
    if (box.id === departmentOf.get(edge.source) || box.id === departmentOf.get(edge.target)) continue
    expect(
      segmentHitsRect(segment[0], segment[1], box),
      `${edge.id} passes through the ${box.id} box`,
    ).toBe(false)
  }
}

/** The points React Flow's smoothstep edge draws between two handles. */
function smoothStepPoints(source: Rect, target: Rect): Point[] {
  const [path] = getSmoothStepPath({
    sourceX: source.x + source.w / 2,
    sourceY: source.y + source.h,
    targetX: target.x + target.w / 2,
    targetY: target.y,
  })
  const tokens = path.match(/[MLCQ]|-?\d+(?:\.\d+)?/g) ?? []
  const points: Point[] = []
  let i = 0
  let command = ""
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/^[MLCQ]$/.test(tokens[i])) command = tokens[i++]
    if (command === "M" || command === "L") {
      points.push({ x: number(), y: number() })
    } else if (command === "Q") {
      const control = { x: number(), y: number() }
      const end = { x: number(), y: number() }
      const start = points[points.length - 1]
      // The corner radius is small; quarter-step sampling is enough to catch a
      // segment that enters a card.
      for (let step = 1; step <= 4; step++) {
        const t = step / 4
        const u = 1 - t
        points.push({
          x: u * u * start.x + 2 * u * t * control.x + t * t * end.x,
          y: u * u * start.y + 2 * u * t * control.y + t * t * end.y,
        })
      }
    } else {
      break
    }
  }
  return points
}

describe("org tree layout with several managers per department", () => {
  const { employees, hierarchy } = fixture()
  const { nodes, edges } = buildTreeLayout(employees, hierarchy, null)
  const employeeNodes: Rect[] = nodes
    .filter((n) => n.type === "employeeNode")
    .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, w: NODE_W, h: NODE_H }))
  const boxes: Rect[] = nodes
    .filter((n) => n.type === "departmentGroup")
    .map((n) => ({
      id: n.id.replace(/^group-/, ""),
      x: n.position.x,
      y: n.position.y,
      w: (n.style as { width: number }).width,
      h: (n.style as { height: number }).height,
    }))
  const byId = new Map(employeeNodes.map((n) => [n.id, n]))
  const departmentOf = new Map(employees.map((e) => [e.name, e.department]))

  it("draws every employee once, inside its own department box", () => {
    expect(employeeNodes).toHaveLength(employees.length)
    for (const node of employeeNodes) {
      const department = departmentOf.get(node.id)
      if (!department) continue // the executive sits above every box
      const owner = boxes.find((box) => box.id === department)
      expect(owner, `${node.id} has no department box`).toBeDefined()
      expect(contains(owner!, node), `${node.id} leaves its department box`).toBe(true)
    }
  })

  it("keeps node cards from overlapping each other", () => {
    for (let i = 0; i < employeeNodes.length; i++) {
      for (let j = i + 1; j < employeeNodes.length; j++) {
        expect(
          overlaps(employeeNodes[i], employeeNodes[j]),
          `${employeeNodes[i].id} overlaps ${employeeNodes[j].id}`,
        ).toBe(false)
      }
    }
  })

  it("keeps node cards out of other departments' boxes", () => {
    for (const node of employeeNodes) {
      for (const box of boxes) {
        if (box.id === departmentOf.get(node.id)) continue
        expect(overlaps(node, box), `${node.id} overlaps the ${box.id} box`).toBe(false)
      }
    }
  })

  it("routes every edge clear of unrelated cards and department boxes", () => {
    for (const edge of edges) {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      expect(source, `${edge.id} has no source card`).toBeDefined()
      expect(target, `${edge.id} has no target card`).toBeDefined()

      const routed = (edge.data as { points?: Point[] } | undefined)?.points
      const points = routed ?? smoothStepPoints(source!, target!)
      expect(points.length, `${edge.id} has no route`).toBeGreaterThanOrEqual(2)

      for (let i = 1; i < points.length; i++) {
        expectSegmentClear(edge, [points[i - 1], points[i]], employeeNodes, boxes, departmentOf)
      }
    }
  })
})
