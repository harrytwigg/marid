import { lazy, Suspense, useState } from "react"
import { useAuth } from "@/routes/auth-provider"
import { useMember } from "@/hooks/use-principal"
import { HumanAvatar } from "@/components/ui/human-avatar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS } from "@/components/chat/session-row-menu"
import { LoadBoundary } from "@/components/ui/lazy-overlay"

const ChangePasswordDialog = lazy(() => import("./change-password-dialog").then((m) => ({ default: m.ChangePasswordDialog })))
const MemberSessionsDialog = lazy(() => import("./member-sessions-dialog").then((m) => ({ default: m.MemberSessionsDialog })))

type Open = "closed" | "password" | "sessions"

/** Name, change password, sessions, sign out: the whole of a member's account. */
export function AccountMenu() {
  const member = useMember()
  const { logout } = useAuth()
  const [open, setOpen] = useState<Open>("closed")
  if (!member) return null
  const { displayName, email } = member.user
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="account-menu"
            aria-label={`Account: ${displayName}`}
            className="focus-outline flex flex-none items-center gap-2 rounded-full py-1 pl-1 pr-2 outline-none hover:bg-[var(--fill-quaternary)]"
          >
            <HumanAvatar name={displayName} size={28} />
            <span className="hidden max-w-[160px] truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)] sm:inline">{displayName}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={SESSION_MENU_CONTENT_CLASS}>
          <DropdownMenuLabel className="flex flex-col gap-0.5 px-2.5 py-2">
            <span className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{displayName}</span>
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} data-testid="account-change-password" onSelect={() => setOpen("password")}>
            Change password…
          </DropdownMenuItem>
          <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} data-testid="account-sessions" onSelect={() => setOpen("sessions")}>
            Sessions…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className={SESSION_MENU_ITEM_CLASS} data-testid="account-sign-out" onSelect={() => void logout()}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open !== "closed" && (
        <LoadBoundary what="The account dialog" onFailed={() => setOpen("closed")}>
          <Suspense fallback={null}>
            {open === "password"
              ? <ChangePasswordDialog onClose={() => setOpen("closed")} />
              : <MemberSessionsDialog onClose={() => setOpen("closed")} />}
          </Suspense>
        </LoadBoundary>
      )}
    </>
  )
}
