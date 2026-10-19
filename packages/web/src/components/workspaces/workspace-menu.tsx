import { lazy, Suspense, useState } from "react"
import { Check, ChevronRight, Layers3, LoaderCircle, Plus, X } from "@/components/ui/icon"
import type { WorkspaceInfo } from "@/lib/api"
import { useStartWorkspace, useWorkspaces } from "@/hooks/use-workspaces"
import { cn } from "@/lib/utils"
import { gatewayTransport } from "@/lib/gateway-transport"
import { nativeBridge } from "@/platform/native-bridge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CreateWorkspaceDialog } from "./create-workspace-dialog"

const NativeWorkspaceSwitcher = lazy(async () => {
  const module = await import("./native-workspace-switcher")
  return { default: module.NativeWorkspaceSwitcher }
})

export type { WorkspaceInfo } from "@/lib/api"

function WorkspaceRow({
  workspace,
  onStart,
  onOpen,
  onRemove,
  starting,
  error,
}: {
  workspace: WorkspaceInfo
  onStart: (workspace: WorkspaceInfo) => void
  onOpen?: (workspace: WorkspaceInfo) => void
  onRemove?: (workspace: WorkspaceInfo) => void
  starting: boolean
  error?: string
}) {
  const content = (
    <>
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: workspace.running ? "var(--system-green)" : "var(--text-quaternary)" }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {workspace.displayName}
        </span>
        <span className="block truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {workspace.warning ?? (workspace.current ? "Current workspace" : workspace.running ? "Online" : starting ? "Starting…" : error ?? "Offline")}
        </span>
      </span>
      {workspace.current && <Check size={15} className="text-[var(--text-secondary)]" aria-hidden />}
    </>
  )
  if (!workspace.current && workspace.running) {
    if (onOpen) {
      if (onRemove) {
        // Remove is a button inside the row: a menu's list holds only items, so it cannot sit beside one.
        // Its presses are its own, never the row's.
        return (
          <DropdownMenuItem
            aria-label={`Open ${workspace.displayName}`}
            onSelect={(event) => {
              event.preventDefault()
              onOpen(workspace)
            }}
            className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)]"
          >
            {content}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Remove ${workspace.displayName}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onRemove(workspace)
              }}
              className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-quaternary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--system-red)]"
            >
              <X size={14} aria-hidden />
            </button>
          </DropdownMenuItem>
        )
      }
      return (
        <DropdownMenuItem
          aria-label={`Open ${workspace.displayName}`}
          onSelect={(event) => {
            event.preventDefault()
            onOpen(workspace)
          }}
          className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)]"
        >
          {content}
        </DropdownMenuItem>
      )
    }
    return (
      <DropdownMenuItem asChild className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)]">
        <a href={workspace.switchUrl} aria-label={`Open ${workspace.displayName}`}>{content}</a>
      </DropdownMenuItem>
    )
  }
  if (!workspace.current) {
    return (
      <DropdownMenuItem
        aria-label={`Start ${workspace.displayName}`}
        disabled={starting}
        onSelect={(event) => {
          event.preventDefault()
          onStart(workspace)
        }}
        className="min-h-12 rounded-[10px] p-2.5 focus:bg-[var(--fill-secondary)] disabled:opacity-100"
      >
        {content}
        {starting && <LoaderCircle size={15} className="animate-spin text-[var(--text-tertiary)]" aria-hidden />}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenuItem disabled className="min-h-12 rounded-[10px] p-2.5 opacity-100 data-[disabled]:opacity-100">
      {content}
    </DropdownMenuItem>
  )
}

export function WorkspaceLauncher({
  workspaces,
  onAdd,
  onStart,
  onOpen,
  onRemove,
  startingId,
  startError,
  className,
}: {
  workspaces: WorkspaceInfo[]
  onAdd: () => void
  onStart: (workspace: WorkspaceInfo) => void
  onOpen?: (workspace: WorkspaceInfo) => void
  onRemove?: (workspace: WorkspaceInfo) => void
  startingId?: string
  startError?: { id: string; message: string } | null
  className?: string
}) {
  const [showOffline, setShowOffline] = useState(false)

  // A workspace stays in the always-visible group while it is starting or is
  // showing a start error, so its row never vanishes mid-action when the
  // offline section happens to be collapsed.
  const isVisible = (workspace: WorkspaceInfo) =>
    workspace.running ||
    workspace.current ||
    (workspace.id !== undefined && (startingId === workspace.id || startError?.id === workspace.id))
  const online = workspaces.filter(isVisible)
  const offline = workspaces.filter((workspace) => !isVisible(workspace))

  // A gateway older than this launcher serves rows without an id, so every
  // `=== workspace.id` must survive undefined on both sides.
  const renderRow = (workspace: WorkspaceInfo) => (
    <WorkspaceRow
      key={workspace.id ?? workspace.name}
      workspace={workspace}
      onStart={onStart}
      onOpen={onOpen}
      onRemove={onRemove}
      starting={workspace.id !== undefined && startingId === workspace.id}
      error={startError && startError.id === workspace.id ? startError.message : undefined}
    />
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Switch workspace"
          title="Switch workspace"
          className={cn(
            "group/row relative flex size-11 shrink-0 items-center justify-center rounded-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] data-[menu-open]:bg-[var(--fill-secondary)] data-[menu-open]:text-[var(--text-primary)]",
            className,
          )}
        >
          <Layers3 size={20} aria-hidden />
          {/* The rail's piano-reveal label. Named so a host with no room to its
              right — the status bar — can suppress it and rely on `title`. */}
          <span aria-hidden data-rail-label className="pointer-events-none absolute inset-y-0 left-full z-50 ml-2 flex items-center">
            <span className="whitespace-nowrap rounded-full border-[0.5px] border-[var(--separator)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-primary)] opacity-0 shadow-[var(--shadow-subtle)] transition-[opacity,transform] duration-150 [transition-timing-function:var(--ease-snappy)] motion-safe:-translate-x-1.5 group-hover/row:translate-x-0 group-hover/row:opacity-100 group-focus-within/row:translate-x-0 group-focus-within/row:opacity-100 motion-reduce:transition-opacity">
              Workspaces
            </span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-[238px] rounded-[var(--radius-lg)] p-1.5"
      >
        <DropdownMenuLabel className="px-2.5 pb-1 pt-2 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          Workspaces
        </DropdownMenuLabel>
        {online.map(renderRow)}
        {offline.length > 0 && (
          // Kept as a DropdownMenuItem (not a Collapsible) so Radix's roving
          // tabindex and typeahead still work; preventDefault keeps the menu
          // open on select, matching the model picker's "More models" toggle.
          <DropdownMenuItem
            aria-expanded={showOffline}
            onSelect={(event) => {
              event.preventDefault()
              setShowOffline((value) => !value)
            }}
            className="min-h-9 rounded-[10px] px-2.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-secondary)]"
          >
            <ChevronRight
              size={13}
              aria-hidden
              className={cn(
                "shrink-0 text-[var(--text-quaternary)] transition-transform duration-150",
                showOffline && "rotate-90",
              )}
            />
            {showOffline ? "Hide offline" : `${offline.length} offline`}
          </DropdownMenuItem>
        )}
        {showOffline && offline.map(renderRow)}
        <DropdownMenuSeparator className="mx-2 my-1 bg-[var(--separator)]" />
        <DropdownMenuItem
          onSelect={onAdd}
          className="min-h-10 rounded-[10px] px-2.5 text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-secondary)] focus:bg-[var(--fill-secondary)] focus:text-[var(--text-primary)]"
        >
          <Plus size={17} aria-hidden />
          Add workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorkspaceSwitcher({ className }: { className?: string }) {
  if (nativeBridge()) {
    return <Suspense fallback={null}><NativeWorkspaceSwitcher className={className} Launcher={WorkspaceLauncher} /></Suspense>
  }
  return <BrowserWorkspaceSwitcher className={className} />
}

function BrowserWorkspaceSwitcher({ className }: { className?: string }) {
  const { data = [] } = useWorkspaces()
  const startWorkspace = useStartWorkspace()
  const [creating, setCreating] = useState(false)
  const [startError, setStartError] = useState<{ id: string; message: string } | null>(null)

  async function handleStart(workspace: WorkspaceInfo) {
    setStartError(null)
    try {
      const started = await startWorkspace.mutateAsync(workspace.id)
      gatewayTransport().navigate(started.switchUrl)
    } catch (error) {
      setStartError({ id: workspace.id, message: error instanceof Error ? error.message : "Could not start workspace" })
    }
  }

  return (
    <>
      <WorkspaceLauncher
        className={className}
        workspaces={data}
        onAdd={() => setCreating(true)}
        onStart={(workspace) => void handleStart(workspace)}
        startingId={startWorkspace.isPending ? startWorkspace.variables : undefined}
        startError={startError}
      />
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}
