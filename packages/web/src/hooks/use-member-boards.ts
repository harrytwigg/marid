import { useQuery } from "@tanstack/react-query"
import { accountsApi } from "@/lib/accounts-api"
import { useMember } from "@/hooks/use-principal"

export const MEMBER_BOARDS_KEY = ["member", "boards"] as const

/** The member's boards as the gateway has them now (the principal in auth state is only as fresh as the page load). */
export function useMemberBoards() {
  const member = useMember()
  return useQuery({ queryKey: MEMBER_BOARDS_KEY, queryFn: accountsApi.listMemberBoards, staleTime: 10_000, enabled: member !== null })
}

/** A board's name as the member sees it: the gateway's title when it gave one, else the slug in words. */
export function memberBoardTitle(board: { department: string; displayName?: string | null }): string {
  return board.displayName ?? board.department.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}
