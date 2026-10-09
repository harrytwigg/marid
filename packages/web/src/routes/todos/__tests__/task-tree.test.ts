import { describe, expect, it } from "vitest"
import type { WorkItemTreeNodeWire } from "@/lib/api"
import { ancestorsOf, nodeOf } from "../task-page/task-tree"

function treeNode(id: string, parentId: string | null, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { id, title: `Item ${id}`, parentId, children } as WorkItemTreeNodeWire
}

describe("ancestor helpers", () => {
  const root = treeNode("PLA-1", null, [
    treeNode("PLA-2", "PLA-1", [treeNode("PLA-4", "PLA-2")]),
    treeNode("PLA-3", "PLA-1"),
  ])

  it("derives the ancestor trail root-first", () => {
    expect(ancestorsOf(root, "PLA-4").map((a) => a.id)).toEqual(["PLA-1", "PLA-2"])
    expect(ancestorsOf(root, "PLA-1")).toEqual([])
    expect(ancestorsOf(root, "PLA-9")).toEqual([])
  })

  it("finds the item's own node", () => {
    expect(nodeOf(root, "PLA-4")?.id).toBe("PLA-4")
    expect(nodeOf(root, "PLA-9")).toBeUndefined()
  })
})
