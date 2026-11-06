// The accounts surface of the gateway: sign-in, invites, resets, People, board sharing.
// Shapes follow the API contract in docs/design/board-members.md. Where that contract leaves a
// shape open (the People list, the board-members list, the member's people), the reading used
// here is named on the type, so the gateway side can match it or say where it differs.

import { gatewayTransport } from "./gateway-transport"

export type BoardRole = "viewer" | "collaborator" | "owner"
export type InstanceRole = "member" | "owner"
export type UserStatus = "active" | "disabled"

export const BOARD_ROLES: readonly BoardRole[] = ["viewer", "collaborator", "owner"]
export const BOARD_ROLE_LABEL: Record<BoardRole, string> = {
  viewer: "Viewer",
  collaborator: "Collaborator",
  owner: "Owner",
}
export const BOARD_ROLE_HINT: Record<BoardRole, string> = {
  viewer: "Can read the board, its Todos and comments.",
  collaborator: "Can also comment, create Todos and edit their own.",
  owner: "Can also invite people to this board and change their roles.",
}

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 256

export interface BoardGrantWire {
  department: string
  role: BoardRole
}

/** The signed-in person as `GET /api/auth/state` reports a member. */
export interface MemberUserWire {
  id: string
  email: string
  displayName: string
}

export type PrincipalWire =
  | { kind: "operator" }
  | { kind: "member"; user: MemberUserWire; boards: BoardGrantWire[] }
  | null

/** One user as People lists them. Reading: `GET /api/people` answers `{ people: PersonWire[] }`. */
export interface PersonWire {
  id: string
  email: string
  displayName: string
  initials: string
  instanceRole: InstanceRole
  status: UserStatus
  boards: BoardGrantWire[]
  /** False until the person has set a password (an invite not yet accepted never reaches here). */
  passwordSet?: boolean
  createdAt?: string
  lastSeenAt?: string | null
}

export interface UserSessionWire {
  id: string
  /** `member` for a user session, `device` for an owner's operator device session. */
  kind: "member" | "device"
  createdAt: string
  lastSeenAt: string | null
  userAgent?: string | null
  ip?: string | null
  current?: boolean
}

export type InviteScope = "board" | "instance"

/** A pending invite. Reading: `department` null is an instance invite. */
export interface PendingInviteWire {
  id: string
  email: string
  department: string | null
  role: BoardRole | null
  instanceRole: InstanceRole | null
  createdBy: string
  createdAt: string
  expiresAt: string
}

/** An invite or reset link, returned once. */
export interface IssuedLinkWire {
  link: string
  expiresAt?: string
}

/** Inviting an email that already has an account adds the grant directly and returns no link. */
export type InviteResultWire =
  | { granted: true; link?: undefined; invite?: undefined }
  | { granted?: false; link: string; expiresAt?: string; invite?: PendingInviteWire }

/** One board's roster for its Share dialog. Reading: `{ members, invites }`. */
export interface BoardMemberWire {
  userId: string
  displayName: string
  email: string
  initials: string
  role: BoardRole
}
export interface BoardRosterWire {
  members: BoardMemberWire[]
  invites: PendingInviteWire[]
}

export interface InviteInspectWire {
  email: string
  boardName?: string | null
  role?: BoardRole | null
  invitedBy?: string | null
}

export interface ResetInspectWire {
  email: string
  displayName?: string | null
}

export interface MemberBoardWire {
  department: string
  role: BoardRole
}

/** A person on a member's boards. Reading: `GET /api/member/people` answers `{ people, employees }`. */
export interface PersonRefWire {
  id: string
  displayName: string
  initials: string
}
export interface MemberEmployeeRefWire {
  name: string
  displayName: string
  emoji?: string
}
export interface MemberPeopleWire {
  people: PersonRefWire[]
  employees: MemberEmployeeRefWire[]
}

export class AccountsError extends Error {
  readonly status: number
  /** Seconds to wait, from a 429's Retry-After header. */
  readonly retryAfterSeconds?: number
  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = "AccountsError"
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Retry-After is delta-seconds or an HTTP date; anything else reads as absent. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number(trimmed))
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(1, Math.ceil((at - now) / 1000))
}

async function failure(res: Response): Promise<AccountsError> {
  let message = `Request failed (${res.status})`
  try {
    const body = await res.json()
    if (body?.error) message = String(body.error)
    else if (body?.message) message = String(body.message)
  } catch {
    /* keep the status message */
  }
  return new AccountsError(res.status, message, parseRetryAfter(res.headers.get("Retry-After")))
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await gatewayTransport().request(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw await failure(res)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const enc = encodeURIComponent

// ── Unauthenticated ────────────────────────────────────────────────────────
export const accountsApi = {
  login: (email: string, password: string) => send<{ ok?: boolean }>("POST", "/api/auth/login", { email, password }),
  inspectInvite: (token: string) => send<InviteInspectWire>("POST", "/api/auth/invites/inspect", { token }),
  acceptInvite: (token: string, displayName: string, password: string) =>
    send<{ ok?: boolean }>("POST", "/api/auth/invites/accept", { token, displayName, password }),
  inspectReset: (token: string) => send<ResetInspectWire>("POST", "/api/auth/resets/inspect", { token }),
  completeReset: (token: string, password: string) =>
    send<{ ok?: boolean }>("POST", "/api/auth/resets/complete", { token, password }),

  // ── Operator ─────────────────────────────────────────────────────────────
  listPeople: async () => (await send<{ people: PersonWire[] }>("GET", "/api/people")).people,
  updatePerson: (id: string, patch: { displayName?: string; status?: UserStatus; instanceRole?: InstanceRole }) =>
    send<{ person: PersonWire }>("PATCH", `/api/people/${enc(id)}`, patch),
  deletePerson: (id: string) => send<void>("DELETE", `/api/people/${enc(id)}`),
  issueResetLink: (id: string) => send<IssuedLinkWire>("POST", `/api/people/${enc(id)}/reset-link`, {}),
  listPersonSessions: async (id: string) =>
    (await send<{ sessions: UserSessionWire[] }>("GET", `/api/people/${enc(id)}/sessions`)).sessions,
  revokePersonSession: (id: string, sessionId: string) =>
    send<void>("DELETE", `/api/people/${enc(id)}/sessions/${enc(sessionId)}`),
  revokeAllPersonSessions: (id: string) => send<void>("DELETE", `/api/people/${enc(id)}/sessions`),
  listPendingInvites: async () =>
    (await send<{ invites: PendingInviteWire[] }>("GET", "/api/people/invites")).invites,
  inviteToInstance: (email: string, instanceRole: InstanceRole) =>
    send<InviteResultWire>("POST", "/api/people/invites", { email, instanceRole }),
  revokeInvite: (id: string) => send<void>("DELETE", `/api/people/invites/${enc(id)}`),
  setupOwnSignIn: (input: { email: string; displayName: string; password: string }) =>
    send<{ person?: PersonWire }>("POST", "/api/account/setup", input),
  changeOwnerPassword: (currentPassword: string, newPassword: string) =>
    send<void>("POST", "/api/account/password", { currentPassword, newPassword }),
  getBoardRoster: (department: string) => send<BoardRosterWire>("GET", `/api/boards/${enc(department)}/members`),
  inviteToBoard: (department: string, email: string, role: BoardRole) =>
    send<InviteResultWire>("POST", `/api/boards/${enc(department)}/invites`, { email, role }),
  revokeBoardInvite: (department: string, id: string) =>
    send<void>("DELETE", `/api/boards/${enc(department)}/invites/${enc(id)}`),
  setBoardRole: (department: string, userId: string, role: BoardRole) =>
    send<void>("PATCH", `/api/boards/${enc(department)}/members/${enc(userId)}`, { role }),
  removeBoardMember: (department: string, userId: string) =>
    send<void>("DELETE", `/api/boards/${enc(department)}/members/${enc(userId)}`),

  // ── Member ───────────────────────────────────────────────────────────────
  changeMemberPassword: (currentPassword: string, newPassword: string) =>
    send<void>("POST", "/api/member/password", { currentPassword, newPassword }),
  listMemberSessions: async () =>
    (await send<{ sessions: UserSessionWire[] }>("GET", "/api/member/sessions")).sessions,
  revokeMemberSession: (id: string) => send<void>("DELETE", `/api/member/sessions/${enc(id)}`),
  listMemberBoards: async () => (await send<{ boards: MemberBoardWire[] }>("GET", "/api/member/boards")).boards,
  getMemberPeople: () => send<MemberPeopleWire>("GET", "/api/member/people"),
  getMemberBoardRoster: (department: string) =>
    send<BoardRosterWire>("GET", `/api/member/boards/${enc(department)}/members`),
  memberInviteToBoard: (department: string, email: string, role: BoardRole) =>
    send<InviteResultWire>("POST", `/api/member/boards/${enc(department)}/invites`, { email, role }),
  memberRevokeBoardInvite: (department: string, id: string) =>
    send<void>("DELETE", `/api/member/boards/${enc(department)}/invites/${enc(id)}`),
  memberSetBoardRole: (department: string, userId: string, role: BoardRole) =>
    send<void>("PATCH", `/api/member/boards/${enc(department)}/members/${enc(userId)}`, { role }),
  memberRemoveBoardMember: (department: string, userId: string) =>
    send<void>("DELETE", `/api/member/boards/${enc(department)}/members/${enc(userId)}`),
}

export type AccountsApi = typeof accountsApi

// ── Pure helpers ────────────────────────────────────────────────────────────
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`
  return null
}

export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return [...words[0]].slice(0, 2).join("").toUpperCase()
  return ([...words[0]][0] + [...words[words.length - 1]][0]).toUpperCase()
}

/** A wait the sign-in form can say out loud. */
export function describeWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}

const USER_PREFIX = "user:"

/** `user:<id>` is how a member is stamped on a Todo, comment or event. */
export function memberIdOf(identity: string | null | undefined): string | null {
  return identity?.startsWith(USER_PREFIX) ? identity.slice(USER_PREFIX.length) : null
}

/** Reads the fragment token once and clears it from the address bar before anything renders. */
export function takeFragmentToken(): string | null {
  if (typeof window === "undefined") return null
  const raw = window.location.hash.replace(/^#/, "").trim()
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
  if (!raw) return null
  const params = new URLSearchParams(raw)
  return (params.get("token") ?? (raw.includes("=") ? "" : raw)).trim() || null
}
