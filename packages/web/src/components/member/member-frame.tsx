import type { ReactNode } from "react"
import { Link, NavLink } from "react-router-dom"
import { BrandMark } from "@/components/brand-mark-image"
import { PRODUCT_NAME } from "@/lib/brand"
import { boardPath } from "@/routes/todos/board/board-route"
import { useMember } from "@/hooks/use-principal"
import { memberBoardTitle, useMemberBoards } from "@/hooks/use-member-boards"
import { AccountMenu } from "./account-menu"

/** What a board member's pages sit in, in place of the operator's rail, tab bar and status bar:
 *  a single header with their boards and their account. Nothing in it reaches an operator route. */
export function MemberFrame({ children }: { children: ReactNode }) {
  const member = useMember()
  const boards = useMemberBoards()
  const list = boards.data ?? member?.boards.map((grant) => ({ ...grant, displayName: null })) ?? []
  return (
    <div data-shell="root" data-member-shell className="flex h-dvh flex-col overflow-hidden bg-background">
      <header className="flex flex-none items-center gap-3 px-3 pb-2 pt-[max(var(--safe-top,0px),8px)] md:px-6">
        <Link to="/" aria-label="Your boards" className="focus-outline flex flex-none items-center gap-2 rounded-[10px] outline-none">
          <BrandMark size={26} />
          <span className="brand-wordmark hidden text-[length:var(--text-subheadline)] text-[var(--text-secondary)] sm:inline">{PRODUCT_NAME}</span>
        </Link>
        <nav aria-label="Boards" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {list.length > 1 && list.map((board) => (
            <NavLink
              key={board.department}
              to={boardPath({ kind: "department", slug: board.department })}
              className={({ isActive }) =>
                `focus-outline flex-none rounded-full px-3 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-medium)] outline-none ${
                  isActive ? "bg-[var(--fill-tertiary)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:bg-[var(--fill-quaternary)]"
                }`}
            >
              {memberBoardTitle(board)}
            </NavLink>
          ))}
        </nav>
        <AccountMenu />
      </header>
      <main data-shell="sheet" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  )
}
