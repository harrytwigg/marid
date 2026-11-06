import { Navigate, Route, Routes, useParams } from "react-router-dom"
import { lazyRoute } from "@/lib/lazy-route"
import { parseBoardParam } from "@/routes/todos/board/board-route"
import { useMemberGrants } from "@/hooks/use-principal"
import { MemberHome } from "./member-home"
import { BoardNotShared } from "./board-not-shared"

const BoardPage = lazyRoute(() => import("@/routes/todos/board/board-page"), "member-board")
const TaskPage = lazyRoute(() => import("@/routes/todos/task-page/task-page"), "member-todo")

function MemberBoardRoute() {
  const { board } = useParams()
  const grants = useMemberGrants()
  const parsed = parseBoardParam(board)
  // The Attention and Everything boards are the operator's: a member's boards are departments they were granted.
  if (parsed.kind !== "department" || !grants?.some((grant) => grant.department === parsed.slug)) {
    return <BoardNotShared />
  }
  return <BoardPage />
}

/** A member has three places: their boards, a board, a Todo. Everything else, the operator's routes
 *  included, sends them back to their boards. */
export function MemberRoutes() {
  return (
    <Routes>
      <Route path="/" element={<MemberHome />} />
      <Route path="/todos/b/:board" element={<MemberBoardRoute />} />
      <Route path="/todos/:todoId" element={<TaskPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
