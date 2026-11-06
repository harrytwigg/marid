import { useQuery } from "@tanstack/react-query"
import { accountsApi } from "@/lib/accounts-api"
import { useMember } from "@/hooks/use-principal"
import { useAuthOptional } from "@/routes/auth-provider"

/**
 * Whether what is written on a Todo is read by other people: the board it is on has members. A member is one themselves
 * (unless the Todo has left their boards, where it names no board). The operator asks for the board's roster, only where
 * accounts are enabled, under the key the Share dialog reads, so the two share one answer.
 */
export function useVisibleToMembers(board: string | null | undefined, moved: boolean): boolean {
  const member = useMember() !== null
  const accountsEnabled = useAuthOptional()?.authState?.accountsEnabled === true
  const roster = useQuery({
    queryKey: ["board-roster", "operator", board ?? ""],
    queryFn: () => accountsApi.getBoardRoster(board!),
    enabled: !member && accountsEnabled && !!board,
    staleTime: 30_000,
    retry: false,
  })
  if (member) return !moved && !!board
  return (roster.data?.members.length ?? 0) > 0
}
