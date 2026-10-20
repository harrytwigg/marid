import { BaseEdge, type EdgeProps } from "@xyflow/react"

export interface RoutePoint {
  x: number
  y: number
}

/**
 * The layout already knows where a cross-department edge may go; React Flow's
 * default smoothstep only knows the two endpoints and picks a midpoint, which
 * is what put those edges through other departments' cards. This edge draws
 * the route the layout computed, and stays a plain BaseEdge so selection,
 * styling and the interaction path keep working.
 */
export function OrgRouteEdge({ data, style, markerEnd }: EdgeProps) {
  const points = (data as { points?: RoutePoint[] } | undefined)?.points
  if (!points || points.length < 2) return null
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={{ ...style, strokeLinejoin: "round" }}
    />
  )
}

export const edgeTypes = { orgRoute: OrgRouteEdge }
