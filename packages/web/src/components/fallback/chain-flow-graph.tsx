import "@xyflow/react/dist/style.css"
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { Handle, MarkerType, Position, ReactFlow, type NodeProps } from "@xyflow/react"
import { buildChainFlow, FLOW_NODE_H, type ChainFlowInput, type FlowOrientation, type FlowTargetData } from "./chain-flow-model"

/** Below this width the chain runs top to bottom; a row of targets would not fit a phone. */
const NARROW_QUERY = "(max-width: 639px)"

function useOrientation(): FlowOrientation {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false)
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY)
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  return narrow ? "vertical" : "horizontal"
}

const DOT_COLOR: Record<FlowTargetData["health"], string> = {
  ok: "var(--system-green)",
  degraded: "var(--system-yellow)",
  exhausted: "var(--system-orange)",
  unknown: "var(--text-quaternary)",
}

const HEALTH_WORD: Record<FlowTargetData["health"], string> = {
  ok: "Healthy",
  degraded: "Degraded",
  exhausted: "At its limit",
  unknown: "No reading",
}

/** The marks a target can carry besides its name. */
function Badges({ data }: { data: FlowTargetData }) {
  const marks = [
    data.current ? "now" : null,
    data.servedLast ? "served last" : null,
    data.legacy ? "from another chain" : null,
  ].filter((m): m is string => m !== null)
  return (
    <>
      {marks.map((mark) => (
        <span key={mark} data-chain-flow-badge={mark} className="shrink-0 rounded-[5px] bg-[var(--fill-secondary)] px-1 text-[length:var(--text-caption2)] text-[var(--text-secondary)]">
          {mark}
        </span>
      ))}
    </>
  )
}

function nodeStyle(target: FlowTargetData): CSSProperties {
  return {
    width: "100%",
    height: FLOW_NODE_H,
    opacity: target.skip ? 0.5 : 1,
    border: `1px ${target.skip ? "dashed" : "solid"} ${target.current ? "var(--accent)" : "var(--separator)"}`,
    boxShadow: target.current ? "0 0 0 1px var(--accent)" : undefined,
  }
}

function nodeName(target: FlowTargetData): string {
  return [target.label, HEALTH_WORD[target.health], target.skipText].filter(Boolean).join(". ")
}

/** One target: its label, a health dot, and what the limits reading says. A link
 *  that would be passed over is dimmed, with the reason on hover and to a screen reader. */
export function ChainTargetNode({ data }: NodeProps) {
  const target = data as FlowTargetData
  const vertical = target.orientation === "vertical"
  const detail = [target.used, target.resets].filter(Boolean).join(" · ")
  return (
    <div
      data-chain-flow-node={target.label}
      data-current={target.current || undefined}
      data-skipped={target.skip ?? undefined}
      title={target.skipText ?? undefined}
      aria-label={nodeName(target)}
      className="flex flex-col justify-center gap-[2px] rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-[var(--space-3)]"
      style={nodeStyle(target)}
    >
      <Handle type="target" position={vertical ? Position.Top : Position.Left} isConnectable={false} className="!opacity-0" />
      <div className="flex min-w-0 items-center gap-[6px]">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: DOT_COLOR[target.health] }} />
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {target.label}
        </span>
      </div>
      <div className="flex min-h-[16px] min-w-0 items-center gap-[4px]">
        <Badges data={target} />
        {detail && <span className="truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">{detail}</span>}
      </div>
      <Handle type="source" position={vertical ? Position.Bottom : Position.Right} isConnectable={false} className="!opacity-0" />
    </div>
  )
}

const nodeTypes = { chainTarget: ChainTargetNode }

/** The chain as a flow: the own target, then each link, joined by "on limit" edges. */
export default function ChainFlowGraph(input: ChainFlowInput) {
  const orientation = useOrientation()
  const graph = useMemo(() => buildChainFlow(input, orientation), [input.links, input.position, input.servedBy, input.now, orientation])
  const edges = useMemo(() => graph.edges.map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--separator-opaque)", strokeWidth: 1.25 },
    labelStyle: { fontSize: 10, fill: "var(--text-tertiary)" },
    labelBgStyle: { fill: "var(--fill-quaternary)" },
  })), [graph])
  return (
    <div data-chain-flow={orientation} style={{ height: Math.min(graph.height, 560), minHeight: 96 }}>
      <ReactFlow
        nodes={graph.nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        minZoom={0.3}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        style={{ background: "transparent" }}
      />
    </div>
  )
}
