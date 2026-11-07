import { Link, Navigate } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { RouteLoading } from "@/components/route-loading"
import { BOARD_ROLE_LABEL } from "@/lib/accounts-api"
import { boardPath } from "@/routes/todos/board/board-route"
import { memberBoardTitle, useMemberBoards } from "@/hooks/use-member-boards"

/** Their boards. A person on exactly one lands straight on it. */
export function MemberHome() {
  const boards = useMemberBoards()
  if (boards.isPending) return <RouteLoading />
  const list = boards.data ?? []
  if (list.length === 1) return <Navigate to={boardPath({ kind: "department", slug: list[0].department })} replace />
  return (
    <PageLayout>
      <div className="mx-auto flex h-full w-full max-w-[640px] flex-col gap-4 overflow-y-auto px-4 py-8 md:px-6" data-testid="member-home">
        <h1 className="text-[28px] font-bold tracking-[-0.41px] text-[var(--text-primary)]">Your boards</h1>
        {boards.isError && <p role="alert" className="text-[var(--system-red)]">Couldn&rsquo;t load your boards.</p>}
        {!boards.isError && list.length === 0 && (
          <p data-testid="member-no-boards" className="text-[var(--text-tertiary)]">
            You aren&rsquo;t on any boards yet. When someone shares one with you it shows up here.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {list.map((board) => (
            <li key={board.department}>
              <Link
                to={boardPath({ kind: "department", slug: board.department })}
                className="focus-outline flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-4 text-[var(--text-primary)] hover:bg-[var(--fill-tertiary)]"
              >
                <span className="font-[var(--weight-semibold)]">{memberBoardTitle(board)}</span>
                <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{BOARD_ROLE_LABEL[board.role]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </PageLayout>
  )
}
