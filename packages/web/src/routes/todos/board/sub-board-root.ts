import { useMemo } from "react"
import type { WorkItemTreeNodeWire, WorkItemTreeWire } from "@/lib/api"
import type { BoardId } from "./board-route"
import { useBoardTrees } from "./use-board"

export interface SubBoardRoot {
  /** The root Todo's tree: its row for the header, its totals for the roll-up. Undefined until it lands, or when the Todo is not readable. */
  tree: WorkItemTreeWire | undefined
  isLoading: boolean
  /** The tree answered and the Todo is not in it: unknown, or not one this person may read. */
  missing: boolean
  /** The root Todo's department, which is the board a member's abilities come from. */
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

/** The root Todo behind a sub-board: one batch tree read (the cache the board's cards already share), so the
 *  header, the member gate and the parent chips cost one query between them. Any other board has none. */
export function useSubBoardRoot(board: BoardId): SubBoardRoot {
  const rootId = board.kind === "subtree" ? board.rootId : null
  const trees = useBoardTrees(rootId ? [rootId] : [])
  const tree = rootId ? trees.data?.get(rootId) : undefined
  const titleById = useMemo(() => (tree ? titlesBelow(tree.root) : NONE), [tree])
  return {
    tree,
    isLoading: rootId !== null && trees.isPending,
    missing: rootId !== null && !trees.isPending && !tree,
    department: tree?.root.department ?? null,
    titleById,
  }
}
