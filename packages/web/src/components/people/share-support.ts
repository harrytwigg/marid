import { accountsApi, BOARD_ROLES, BOARD_ROLE_LABEL, type BoardRole } from "@/lib/accounts-api"

export type ShareMode = "operator" | "member"

export const rank = (role: BoardRole) => BOARD_ROLES.indexOf(role)

/** The operator is above every role. A member owner grants up to their own and touches nobody above it. */
export function ceilingOf(mode: ShareMode, ownRole: BoardRole | undefined): BoardRole {
  return mode === "operator" ? "owner" : ownRole ?? "viewer"
}

export function endpoints(mode: ShareMode) {
  return mode === "operator"
    ? {
        roster: accountsApi.getBoardRoster,
        invite: accountsApi.inviteToBoard,
        revoke: accountsApi.revokeBoardInvite,
        setRole: accountsApi.setBoardRole,
        remove: accountsApi.removeBoardMember,
      }
    : {
        roster: accountsApi.getMemberBoardRoster,
        invite: accountsApi.memberInviteToBoard,
        revoke: accountsApi.memberRevokeBoardInvite,
        setRole: accountsApi.memberSetBoardRole,
        remove: accountsApi.memberRemoveBoardMember,
      }
}

export function roleOptions(ceiling: BoardRole) {
  return BOARD_ROLES.filter((role) => rank(role) <= rank(ceiling)).map((role) => ({ value: role, label: BOARD_ROLE_LABEL[role] }))
}

export const HEADING = "pb-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]"
