import { useQuery } from "@tanstack/react-query"
import { useAuthOptional } from "@/routes/auth-provider"
import { accountsApi, type BoardRole, type MemberUserWire, type PrincipalWire } from "@/lib/accounts-api"

export const MEMBER_BOARDS_KEY = ["member", "boards"] as const

export interface MemberPrincipal {
  user: MemberUserWire
  boards: { department: string; role: BoardRole }[]
}

export function usePrincipal(): PrincipalWire {
  return useAuthOptional()?.principal ?? null
}

/** The signed-in board member, or null for the operator and for everything outside a sign-in. */
export function useMember(): MemberPrincipal | null {
  const principal = usePrincipal()
  return principal?.kind === "member" ? { user: principal.user, boards: principal.boards } : null
}

/** What a member may do on one board. The operator has no member role: callers branch on `useMember()` first. */
export interface BoardAbilities {
  role: BoardRole | null
  /** Comment, reply, attach; create root Todos on the board. */
  canContribute: boolean
  /** Invite to, change roles on and remove people from the board. */
  canShare: boolean
}

export function abilitiesFor(role: BoardRole | null | undefined): BoardAbilities {
  return {
    role: role ?? null,
    canContribute: role === "collaborator" || role === "owner",
    canShare: role === "owner",
  }
}

/** The boards a member holds, and as what. The principal in auth state is only as fresh as the last read of it, so a
 *  grant or role change made mid-session reaches the page through the boards query, which is what the board list and
 *  tabs read too. The principal is the answer until that query has one (and if it fails). */
export function useMemberGrants(): { department: string; role: BoardRole }[] | null {
  const member = useMember()
  const boards = useQuery({ queryKey: MEMBER_BOARDS_KEY, queryFn: accountsApi.listMemberBoards, staleTime: 10_000, enabled: member !== null })
  if (!member) return null
  return boards.data ?? member.boards
}

export function useBoardAbilities(department: string | null | undefined): BoardAbilities | null {
  const grants = useMemberGrants()
  if (!grants) return null
  return abilitiesFor(grants.find((board) => board.department === department)?.role)
}
