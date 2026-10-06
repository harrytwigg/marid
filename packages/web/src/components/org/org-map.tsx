import "@xyflow/react/dist/style.css"
import {
  ReactFlow,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  ConnectionLineType,
} from "@xyflow/react"
import { useCallback, useEffect } from "react"
import type { Employee, OrgHierarchy } from "@/lib/api"
import type { DepartmentScopeWire } from "@/lib/department-api"
import { nodeTypes } from "@/components/org/employee-node"
import { computeOrgLayout } from "@/components/org/layout/use-layouted-elements"

interface OrgMapProps {
  employees: Employee[]
  hierarchy?: OrgHierarchy
  selectedName: string | null
  onNodeClick: (employee: Employee) => void
  /** The scope of each department that is not open, by slug. */
  scopes?: Record<string, DepartmentScopeWire>
  /** A department's group box was clicked. */
  onDepartmentClick?: (slug: string) => void
}

export function OrgMap({ employees, hierarchy, selectedName, onNodeClick, scopes, onDepartmentClick }: OrgMapProps) {
  const buildLayout = useCallback(
    () => computeOrgLayout(employees, hierarchy, selectedName, scopes),
    [employees, hierarchy, selectedName, scopes],
  )

  const { nodes: initialNodes, edges: initialEdges } = buildLayout()
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const { nodes: n, edges: e } = buildLayout()
    setNodes(n)
    setEdges(e)
  }, [buildLayout, setNodes, setEdges])

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === "departmentGroup") return onDepartmentClick?.((node.data as { label: string }).label)
      const employee = employees.find((e) => e.name === node.id)
      if (employee) onNodeClick(employee)
    },
    [employees, onNodeClick, onDepartmentClick],
  )

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      nodeTypes={nodeTypes}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
      fitViewOptions={{ padding: 0.22, duration: 400 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      {/* Low-noise chrome: fit + zoom only, no lock/interactive toggle. */}
      <Controls
        position="bottom-left"
        showInteractive={false}
        style={{ left: 16, bottom: 16 }}
      />
    </ReactFlow>
  )
}
