import { useBoardAbilities, useMember } from "@/hooks/use-principal"
import type { BoardId } from "./board-route"
import { useSubBoardRoot } from "./sub-board-root"

export interface BoardMemberView {
  /** A board member's session: the operator's board controls (drag, move, pin, filters, sprints, capture, sub-task quick-add) are off. */
  member: boolean
  /** May file a Todo here: always for the operator, collaborators and owners for a member. */
  canCreate: boolean
}

export function useBoardMemberView(board: BoardId): BoardMemberView {
  const member = useMember() !== null
  // A sub-board has no board of its own: a member holds it through the board its root Todo is on.
  const subRoot = useSubBoardRoot(board)
  const abilities = useBoardAbilities(board.kind === "department" ? board.slug : board.kind === "subtree" ? subRoot.department : null)
  return { member, canCreate: !member || abilities?.canContribute === true }
}
