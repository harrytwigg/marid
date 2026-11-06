import { useAuthOptional } from "@/routes/auth-provider"
import type { BoardRole, MemberUserWire, PrincipalWire } from "@/lib/accounts-api"

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

export function useBoardAbilities(department: string | null | undefined): BoardAbilities | null {
  const member = useMember()
  if (!member) return null
  const grant = member.boards.find((board) => board.department === department)
  return abilitiesFor(grant?.role)
}
