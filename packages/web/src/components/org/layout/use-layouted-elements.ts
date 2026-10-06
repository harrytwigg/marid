import type { Edge } from "@xyflow/react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import type { DepartmentScopeWire } from "@/lib/department-api"
import { buildTreeLayout, type LayoutResult } from "./d3-tree-layout"
import { buildHierarchyLayout } from "./dagre-fallback"

// The layout seam. org-map.tsx calls this and stays agnostic to the engine —
// swapping in elkjs later means changing only this file. Today: d3-tree tidy
// layout with a dagre fallback if the org isn't a clean single-rooted tree.

function styleEdges(edges: Edge[]): Edge[] {
  return edges.map((e) => {
    const hi = Boolean((e.data as { highlighted?: boolean } | undefined)?.highlighted)
    return {
      ...e,
      animated: hi,
      style: {
        stroke: hi ? "var(--accent)" : "var(--separator-opaque)",
        strokeWidth: hi ? 2 : 1.25,
        opacity: hi ? 1 : 0.6,
      },
    }
  })
}

/** Stamp each department group box with its scope, so the box can show its badge. Open departments carry none. */
function withScopes(nodes: LayoutResult["nodes"], scopes: Record<string, DepartmentScopeWire> | undefined): LayoutResult["nodes"] {
  if (!scopes) return nodes
  return nodes.map((node) => {
    if (node.type !== "departmentGroup") return node
    const label = (node.data as { label: string }).label
    return { ...node, data: { ...node.data, scope: scopes[label] } }
  })
}

export function computeOrgLayout(
  employees: Employee[],
  hierarchy: OrgHierarchy | undefined,
  selectedName: string | null,
  scopes?: Record<string, DepartmentScopeWire>,
): LayoutResult {
  let result: LayoutResult
  if (hierarchy) {
    try {
      result = buildTreeLayout(employees, hierarchy, selectedName)
    } catch (err) {
      // Non-strict tree (multi-parent / cycle / multi-root): fall back to dagre.
      console.warn(
        "[org-map] d3-tree layout failed, falling back to dagre:",
        err instanceof Error ? err.message : err,
      )
      result = buildHierarchyLayout(employees, hierarchy, selectedName)
    }
  } else {
    // No hierarchy data at all — dagre's department layout handles the flat case.
    result = buildHierarchyLayout(
      employees,
      { root: null, sorted: employees.map((e) => e.name), warnings: [] },
      selectedName,
    )
  }
  return { nodes: withScopes(result.nodes, scopes), edges: styleEdges(result.edges) }
}
