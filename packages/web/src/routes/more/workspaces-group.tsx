import { useState, useSyncExternalStore } from "react"
import { ChevronRight, LoaderCircle, Plus, X } from "@/components/ui/icon"
import { NativePairingDialog } from "@/components/auth/native-pairing-screen"
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog"
import { useStartWorkspace, useWorkspaces } from "@/hooks/use-workspaces"
import type { WorkspaceInfo } from "@/lib/api"
import { gatewayTransport } from "@/lib/gateway-transport"
import { nativeGatewayProfiles } from "@/lib/native-gateway-bootstrap"
import { cn } from "@/lib/utils"
import { nativeBridge } from "@/platform/native-bridge"

function Card({ children }: { children: React.ReactNode }) {
  return <div className="glass-card overflow-hidden rounded-[var(--radius-lg)]">{children}</div>
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-[7px] pt-4 text-[length:var(--text-caption1)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">{children}</div>
}

function WorkspaceRow({ workspace, first, onStart, onOpen, onRemove, starting, error }: {
  workspace: WorkspaceInfo
  first: boolean
  onStart: (workspace: WorkspaceInfo) => void
  onOpen?: (workspace: WorkspaceInfo) => void
  onRemove?: (workspace: WorkspaceInfo) => void
  starting: boolean
  error?: string
}) {
  const content = <WorkspaceRowContent workspace={workspace} starting={starting} error={error} onRemove={onRemove} />
  const className = cn("flex h-[52px] w-full items-center gap-3 px-3.5 text-left transition-colors", !first && "border-t-[0.5px] border-[var(--separator)]", !workspace.current && "active:bg-[var(--fill-secondary)]")
  if (!workspace.current && workspace.running) {
    if (onOpen) return <div role="button" tabIndex={0} aria-label={`Open ${workspace.displayName}`} className={className} onClick={() => onOpen(workspace)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(workspace) }}>{content}</div>
    return <a href={workspace.switchUrl} className={className}>{content}</a>
  }
  if (!workspace.current) return <button type="button" aria-label={`Start ${workspace.displayName}`} className={className} disabled={starting} onClick={() => onStart(workspace)}>{content}</button>
  return <div className={className}>{content}</div>
}

function WorkspaceRowContent({ workspace, starting, error, onRemove }: {
  workspace: WorkspaceInfo
  starting: boolean
  error?: string
  onRemove?: (workspace: WorkspaceInfo) => void
}) {
  return <>
    <span className="size-2 shrink-0 rounded-full" style={{ background: workspace.running ? "var(--system-green)" : "var(--text-quaternary)" }} aria-hidden />
    <span className={cn("flex-1 truncate text-[length:var(--text-body)] tracking-[-0.01em]", workspace.current ? "font-[var(--weight-semibold)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]")}>{workspace.displayName}</span>
    <span className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{workspaceStatus(workspace, starting, error)}</span>
    {!workspace.current && !starting && <ChevronRight size={18} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden />}
    {starting && <LoaderCircle size={18} className="shrink-0 animate-spin text-[var(--text-quaternary)]" aria-hidden />}
    {!workspace.current && onRemove && <button type="button" aria-label={`Remove ${workspace.displayName}`} onClick={(event) => { event.stopPropagation(); onRemove(workspace) }} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-quaternary)] active:bg-[var(--fill-tertiary)] active:text-[var(--system-red)]"><X size={16} aria-hidden /></button>}
  </>
}

function workspaceStatus(workspace: WorkspaceInfo, starting: boolean, error?: string): string {
  if (workspace.warning) return workspace.warning
  if (workspace.current) return "Current"
  if (workspace.running) return "Online"
  if (starting) return "Starting…"
  return error ?? "Offline"
}

export function WorkspacesGroup() {
  if (nativeBridge()) return <NativeWorkspacesGroup />
  return <BrowserWorkspacesGroup />
}

function BrowserWorkspacesGroup() {
  const { data: workspaces = [] } = useWorkspaces()
  const startWorkspace = useStartWorkspace()
  const [creating, setCreating] = useState(false)
  const [startError, setStartError] = useState<{ id: string; message: string } | null>(null)
  const [showOffline, setShowOffline] = useState(false)

  async function handleStart(workspace: WorkspaceInfo) {
    setStartError(null)
    try {
      const started = await startWorkspace.mutateAsync(workspace.id)
      gatewayTransport().navigate(started.switchUrl)
    } catch (error) {
      setStartError({ id: workspace.id, message: error instanceof Error ? error.message : "Could not start workspace" })
    }
  }

  const isVisible = (workspace: WorkspaceInfo) => workspace.running || workspace.current || (startWorkspace.isPending && startWorkspace.variables === workspace.id) || startError?.id === workspace.id
  const online = workspaces.filter(isVisible)
  const offline = workspaces.filter((workspace) => !isVisible(workspace))
  const visible = showOffline ? [...online, ...offline] : online
  return <>
    <GroupLabel>Workspaces</GroupLabel>
    <Card>
      {visible.map((workspace, index) => <WorkspaceRow key={workspace.id} workspace={workspace} first={index === 0} onStart={(candidate) => void handleStart(candidate)} starting={startWorkspace.isPending && startWorkspace.variables === workspace.id} error={startError?.id === workspace.id ? startError.message : undefined} />)}
      {offline.length > 0 && <button type="button" aria-expanded={showOffline} onClick={() => setShowOffline((value) => !value)} className={cn("flex h-[52px] w-full items-center gap-3 px-3.5 text-left text-[var(--text-secondary)] transition-colors active:bg-[var(--fill-secondary)]", visible.length > 0 && "border-t-[0.5px] border-[var(--separator)]")}><span className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]"><ChevronRight size={17} aria-hidden className={cn("transition-transform duration-150", showOffline && "rotate-90")} /></span><span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em]">{showOffline ? "Hide offline" : `${offline.length} offline`}</span></button>}
      <AddRow label="Add workspace" divided={workspaces.length > 0} onClick={() => setCreating(true)} />
    </Card>
    <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
  </>
}

function NativeWorkspacesGroup() {
  const profiles = nativeGatewayProfiles()!
  const snapshot = useSyncExternalStore(profiles.subscribe, profiles.snapshot, profiles.snapshot)
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  const workspaces: WorkspaceInfo[] = snapshot.profiles.map((profile) => ({ id: profile.id, name: profile.name, displayName: profile.name, port: Number(new URL(profile.origin).port), running: true, current: profile.id === snapshot.activeId, switchUrl: profile.origin, warning: snapshot.failedProfileId === profile.id ? snapshot.error ?? "Unreachable" : undefined }))
  async function select(workspace: WorkspaceInfo) {
    setError(null)
    try { await profiles.select(workspace.id) } catch (reason) { setError({ id: workspace.id, message: reason instanceof Error ? reason.message : "Gateway is unreachable" }) }
  }
  async function remove(workspace: WorkspaceInfo) {
    setError(null)
    try { await profiles.remove(workspace.id) } catch (reason) { setError({ id: workspace.id, message: reason instanceof Error ? reason.message : "Gateway could not be removed" }) }
  }
  return <>
    <GroupLabel>Workspaces</GroupLabel>
    <Card>
      {workspaces.map((workspace, index) => <WorkspaceRow key={workspace.id} workspace={workspace} first={index === 0} onStart={(candidate) => void select(candidate)} onOpen={(candidate) => void select(candidate)} onRemove={(candidate) => void remove(candidate)} starting={snapshot.switchingProfileId === workspace.id} error={error?.id === workspace.id ? error.message : undefined} />)}
      <AddRow label="Add gateway" divided={workspaces.length > 0} onClick={() => setPairing(true)} />
    </Card>
    <NativePairingDialog open={pairing} onOpenChange={setPairing} />
  </>
}

function AddRow({ label, divided, onClick }: { label: string; divided: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={cn("flex h-[52px] w-full items-center gap-3 px-3.5 text-left text-[var(--text-primary)] transition-colors active:bg-[var(--fill-secondary)]", divided && "border-t-[0.5px] border-[var(--separator)]")}><span className="flex size-[29px] shrink-0 items-center justify-center rounded-[8px] bg-[var(--fill-tertiary)] text-[var(--text-secondary)]"><Plus size={17} aria-hidden /></span><span className="flex-1 text-[length:var(--text-body)] font-[var(--weight-medium)] tracking-[-0.01em]">{label}</span><ChevronRight size={18} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden /></button>
}
