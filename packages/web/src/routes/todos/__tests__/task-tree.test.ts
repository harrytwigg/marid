import { describe, expect, it } from "vitest"
import type { WorkItemTreeNodeWire } from "@/lib/api"
import { ancestorsOf, nodeOf } from "../task-page/task-tree"

function treeNode(id: string, parentId: string | null, children: WorkItemTreeNodeWire[] = []): WorkItemTreeNodeWire {
  return { id, title: `Item ${id}`, parentId, children } as WorkItemTreeNodeWire
}

describe("ancestor helpers", () => {
  const root = treeNode("TSK-1", null, [
    treeNode("TSK-2", "TSK-1", [treeNode("TSK-4", "TSK-2")]),
    treeNode("TSK-3", "TSK-1"),
  ])

  it("derives the ancestor trail root-first", () => {
    expect(ancestorsOf(root, "TSK-4").map((a) => a.id)).toEqual(["TSK-1", "TSK-2"])
    expect(ancestorsOf(root, "TSK-1")).toEqual([])
    expect(ancestorsOf(root, "TSK-9")).toEqual([])
  })

  it("finds the item's own node", () => {
    expect(nodeOf(root, "TSK-4")?.id).toBe("TSK-4")
    expect(nodeOf(root, "TSK-9")).toBeUndefined()
  })
})
