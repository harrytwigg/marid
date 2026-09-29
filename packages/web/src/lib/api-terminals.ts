import { get, post } from "@/lib/api"

/**
 * Operator terminals: the machines a terminal can open on, and
 * creating one. A terminal is a session (engine and source "terminal"), so
 * everything after creation — listing, rename, delete, the grid — goes through
 * the ordinary session calls.
 */

export interface TerminalHostWire {
  id: string
  label: string
  kind: "local" | "ssh"
  detail?: string
  destination?: string
  cwd?: string
}

export interface TerminalHostsWire {
  enabled: boolean
  hosts: TerminalHostWire[]
  problems: string[]
  disabledReason?: string
}

/** Beside `api` rather than spread into it: api.ts is at its size budget. */
export const terminalsApi = {
  listTerminalHosts: () => get<TerminalHostsWire>("/api/terminals/hosts"),
  createTerminal: (hostId: string) => post<Record<string, unknown>>("/api/terminals", { hostId }),
}
