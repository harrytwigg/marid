import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PanelRightOpen, Plus, SquareTerminal } from "lucide-react"
import { useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SESSION_MENU_CONTENT_CLASS, SESSION_MENU_ITEM_CLASS, SESSION_MENU_SEPARATOR_CLASS } from "@/components/chat/session-row-menu"
import { terminalsApi, type TerminalHostWire } from "@/lib/api-terminals"
import { focusTerminalWhenMounted } from "@/lib/terminal-focus"
import { queryKeys } from "@/lib/query-keys"
import { cn } from "@/lib/utils"

/**
 * The sidebar's Terminals section: a header with a host menu that
 * opens a shell on any machine the gateway is configured to reach, above the
 * terminal sessions themselves (rendered by the sidebar as ordinary rows).
 */

const TERMINAL_HOSTS_KEY = ["terminal-hosts"] as const

export function useTerminalHosts() {
  return useQuery({
    queryKey: TERMINAL_HOSTS_KEY,
    queryFn: () => terminalsApi.listTerminalHosts(),
    staleTime: 30_000,
    // An older gateway has no route; the section simply stays hidden.
    retry: false,
  })
}

export function useCreateTerminal() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (hostId: string) => terminalsApi.createTerminal(hostId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
  })
}

const LABEL_CLASS = "text-caption2 font-[var(--weight-medium)] tracking-[0.06em] text-[var(--text-tertiary)]"
const COUNT_CLASS = "text-caption2 tabular-nums text-[var(--text-quaternary)]"

function HostItem({ host, beside, onPick }: { host: TerminalHostWire; beside?: boolean; onPick: (host: TerminalHostWire) => void }) {
  const Icon = beside ? PanelRightOpen : SquareTerminal
  return (
    <DropdownMenuItem className={cn(SESSION_MENU_ITEM_CLASS, "items-start")} onClick={() => onPick(host)}>
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-subheadline">{host.label}</span>
        {host.detail && !beside ? (
          <span className="block truncate text-caption2 text-[var(--text-tertiary)]">{host.detail}</span>
        ) : null}
      </span>
    </DropdownMenuItem>
  )
}

function TerminalHostMenu({
  hosts,
  pending,
  beside,
  onPick,
}: {
  hosts: TerminalHostWire[]
  pending: boolean
  beside: boolean
  onPick: (host: TerminalHostWire, beside: boolean) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open a terminal"
          title="Open a terminal"
          disabled={pending}
          className={cn(
            "ml-auto flex size-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors",
            "hover:bg-[var(--fill-tertiary)] hover:text-[var(--accent)] disabled:opacity-50",
          )}
        >
          <Plus className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={cn(SESSION_MENU_CONTENT_CLASS, "w-64")}>
        <DropdownMenuLabel className="text-caption2 text-[var(--text-tertiary)]">Open a terminal on</DropdownMenuLabel>
        {hosts.map((host) => <HostItem key={host.id} host={host} onPick={(h) => onPick(h, false)} />)}
        {beside ? (
          <>
            <DropdownMenuSeparator className={SESSION_MENU_SEPARATOR_CLASS} />
            <DropdownMenuLabel className="text-caption2 text-[var(--text-tertiary)]">Open beside the current chat</DropdownMenuLabel>
            {hosts.map((host) => <HostItem key={host.id} host={host} beside onPick={(h) => onPick(h, true)} />)}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TerminalSectionHeader({
  count,
  hosts,
  onOpen,
  onOpenBeside,
}: {
  count: number
  hosts: TerminalHostWire[]
  onOpen: (sessionId: string) => void
  onOpenBeside?: (sessionId: string) => void
}) {
  const createTerminal = useCreateTerminal()
  const [error, setError] = useState<string | null>(null)
  const open = (host: TerminalHostWire, beside: boolean) => {
    setError(null)
    createTerminal.mutate(host.id, {
      onSuccess: (session) => {
        const id = typeof session?.id === "string" ? session.id : null
        if (!id) return
        focusTerminalWhenMounted(id)
        if (beside && onOpenBeside) onOpenBeside(id)
        else onOpen(id)
      },
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    })
  }
  return (
    <div data-sidebar-terminals>
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className={LABEL_CLASS}>Terminals</span>
        {count > 0 ? <span className={COUNT_CLASS}>{count}</span> : null}
        {hosts.length > 0 ? (
          <TerminalHostMenu hosts={hosts} pending={createTerminal.isPending} beside={Boolean(onOpenBeside)} onPick={open} />
        ) : null}
      </div>
      {error ? <p role="alert" className="px-4 pb-1 text-caption2 text-[var(--system-red)]">{error}</p> : null}
    </div>
  )
}
