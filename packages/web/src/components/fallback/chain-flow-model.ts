import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"
import type { FallbackLinkHealth, FallbackSkipReason, ResolvedFallbackLink } from "@jinn/fallback-chain-wire"
import { formatReset, formatUsed, SKIP_REASON_TEXT } from "@/lib/fallback-format"

/* The chain diagram's data and layout, apart from the component that draws it. */

export const FLOW_NODE_W = 176
export const FLOW_NODE_H = 68

export type FlowOrientation = "horizontal" | "vertical"

export interface FlowTargetData extends Record<string, unknown> {
  label: string
  /** The session's (or subject's) own target: the start of the chain. */
  own: boolean
  health: FallbackLinkHealth["state"]
  used: string | null
  resets: string | null
  skip: FallbackSkipReason | null
  skipText: string | null
  /** Expanded from another entry's own chain, not written on this one. */
  legacy: boolean
  /** The target the session is on now. */
  current: boolean
  /** The target that served the latest turn. */
  servedLast: boolean
  orientation: FlowOrientation
}

export interface ChainFlowInput {
  /** Index 0 is the own target, then the chain in order. */
  links: ResolvedFallbackLink[]
  /** Index into `links` of the target a session is on now. */
  position?: number
  /** Key of the target that served the latest turn. */
  servedBy?: string | null
  now?: number
}

function targetData(link: ResolvedFallbackLink, index: number, input: ChainFlowInput, orientation: FlowOrientation): FlowTargetData {
  const reset = link.health?.state === "exhausted" ? formatReset(link.health.until, input.now) : null
  return {
    label: link.label,
    own: index === 0,
    health: link.health?.state ?? "unknown",
    used: formatUsed(link.health?.usedPercent),
    resets: reset ? `resets ${reset}` : null,
    skip: link.skip ?? null,
    skipText: link.skip ? SKIP_REASON_TEXT[link.skip] : null,
    legacy: link.origin === "legacy",
    current: input.position === index,
    servedLast: input.servedBy != null && input.servedBy === link.key,
    orientation,
  }
}

function layout(count: number, orientation: FlowOrientation): { x: number; y: number }[] {
  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: orientation === "horizontal" ? "LR" : "TB", nodesep: 16, ranksep: orientation === "horizontal" ? 64 : 44, marginx: 8, marginy: 8 })
  for (let i = 0; i < count; i++) g.setNode(String(i), { width: FLOW_NODE_W, height: FLOW_NODE_H })
  for (let i = 1; i < count; i++) g.setEdge(String(i - 1), String(i))
  dagre.layout(g)
  return Array.from({ length: count }, (_, i) => {
    const { x, y } = g.node(String(i))
    return { x: x - FLOW_NODE_W / 2, y: y - FLOW_NODE_H / 2 }
  })
}

export interface ChainFlowGraph {
  nodes: Node<FlowTargetData>[]
  edges: Edge[]
  width: number
  height: number
}

/** The nodes and "on limit" edges of one chain, laid out left to right or top to bottom. */
export function buildChainFlow(input: ChainFlowInput, orientation: FlowOrientation): ChainFlowGraph {
  const at = layout(input.links.length, orientation)
  const nodes = input.links.map((link, index) => ({
    id: String(index),
    type: "chainTarget",
    position: at[index],
    width: FLOW_NODE_W,
    height: FLOW_NODE_H,
    data: targetData(link, index, input, orientation),
    draggable: false,
    selectable: false,
  }))
  const edges: Edge[] = input.links.slice(1).map((_, i) => ({
    id: `e${i}`,
    source: String(i),
    target: String(i + 1),
    type: "smoothstep",
    label: "on limit",
  }))
  const last = at[at.length - 1] ?? { x: 0, y: 0 }
  return { nodes, edges, width: last.x + FLOW_NODE_W + 16, height: last.y + FLOW_NODE_H + 16 }
}
