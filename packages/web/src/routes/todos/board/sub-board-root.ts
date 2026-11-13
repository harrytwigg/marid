import { useMemo } from "react"
import type { WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardId } from "./board-route"
import { useBoardTrees } from "./use-board"

export interface SubBoardRoot {
  /** The root Todo's tree: its row for the header, its totals for the roll-up. Undefined until it lands, or when the Todo is not readable. */
  tree: WorkItemTreeWire | undefined
  /** The tree answered and the Todo is not in it: unknown, or not one this person may read. */
  missing: boolean
  /** The department of the Todo's own root, which is the board a member's abilities come from. Null until it lands. */
  department: string | null
  /** Every Todo below the root by id, so a card can name its parent without a fetch of its own. */
  titleById: ReadonlyMap<string, string>
}

const NONE: ReadonlyMap<string, string> = new Map()

function titlesBelow(root: WorkItemTreeNodeWire): Map<string, string> {
  const titles = new Map<string, string>()
  const walk = (node: WorkItemTreeNodeWire) => {
    titles.set(node.id, node.title)
    node.children?.forEach(walk)
  }
  walk(root)
  return titles
}

/** The department of the Todo's own root, which is the board a member's abilities come from: a sub-Todo can name
 *  another department than its root. The Todo's own tree answers when it is the root; otherwise the root's is read. */
function useRootDepartment(tree: WorkItemTreeWire | undefined): string | null {
  const rootId = tree?.root.rootId
  const own = !rootId || rootId === tree.root.id
  const trees = useBoardTrees(own ? [] : [rootId])
  return (own ? tree?.root.department : trees.data?.get(rootId)?.root.department) ?? null
}

/** The root Todo behind a sub-board: one batch tree read (the cache the board's cards already share), so the
 *  header, the member gate and the parent chips cost one query between them. Any other board has none. */
export function useSubBoardRoot(board: BoardId): SubBoardRoot {
  const rootId = board.kind === "subtree" ? board.rootId : null
  const trees = useBoardTrees(rootId ? [rootId] : [])
  const tree = rootId ? trees.data?.get(rootId) : undefined
  const department = useRootDepartment(tree)
  const titleById = useMemo(() => (tree ? titlesBelow(tree.root) : NONE), [tree])
  return {
    tree,
    missing: rootId !== null && !trees.isPending && !tree,
    department,
    titleById,
  }
}
