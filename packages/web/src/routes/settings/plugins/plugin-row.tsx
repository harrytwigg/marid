import { FolderOpen } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { ToggleSwitch } from "../shared"
import type { PluginInventoryRow, PluginStatus } from "./inventory"

/** The pill's colour per status. Errors read as a red wash rather than a solid
 *  alarm block, the same restraint the Reset section uses. */
const STATUS_TINT: Record<PluginStatus, { label: string; fg: string; bg: string }> = {
  loaded: {
    label: "Loaded",
    fg: "var(--system-green)",
    bg: "color-mix(in srgb, var(--system-green) 13%, transparent)",
  },
  disabled: { label: "Disabled", fg: "var(--text-tertiary)", bg: "var(--fill-tertiary)" },
  error: {
    label: "Error",
    fg: "var(--system-red)",
    bg: "color-mix(in srgb, var(--system-red) 13%, transparent)",
  },
}

const KIND_LABEL: Record<PluginInventoryRow["kind"], string> = {
  client: "Dashboard only",
  "client+server": "Dashboard + gateway",
}

function StatusPill({ status }: { status: PluginStatus }) {
  const { label, fg, bg } = STATUS_TINT[status]
  return (
    <span
      data-testid={`plugin-status-${status}`}
      className="inline-flex h-[22px] flex-none items-center rounded-full px-2.5 text-[length:var(--text-caption2)] font-semibold"
      style={{ background: bg, color: fg }}
    >
      {label}
    </span>
  )
}

/** What the plugin is: its name and state, what it can reach, and why it is not
 *  running when it is not. */
function PluginIdentity({ plugin }: { plugin: PluginInventoryRow }) {
  return (
    <span className="flex min-w-0 flex-1 basis-[200px] flex-col gap-[3px]">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[length:var(--text-subheadline)] font-medium leading-[1.3] text-[var(--text-primary)]">
          {plugin.name}
        </span>
        <StatusPill status={plugin.status} />
      </span>
      <span className="flex min-w-0 items-center gap-[7px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <span className="tabular-nums">v{plugin.version}</span>
        <span className="text-[var(--text-quaternary)]">·</span>
        <span className="truncate">{KIND_LABEL[plugin.kind]}</span>
      </span>
      {plugin.error && (
        <span
          data-testid={`plugin-error-${plugin.id}`}
          className="text-[length:var(--text-caption1)] leading-[1.4] text-[var(--system-red)]"
        >
          {plugin.error}
        </span>
      )}
    </span>
  )
}

/**
 * One plugin. Everything an operator needs to decide about it is on the row:
 * what it is, what it can reach, whether it is running, and why not when it is
 * not.
 */
export function PluginRow({
  plugin,
  onToggle,
  onReveal,
}: {
  plugin: PluginInventoryRow
  onToggle: (enabled: boolean) => void
  onReveal: () => void
}) {
  // A broken plugin carries no switch. Its inventory row says "error" and not
  // which of the operator's two lists it is in, so a switch here would have to
  // pick a position it cannot know — and a control that shows a state nobody
  // asked for is worse than no control. The row still shows, with its reason:
  // one that vanished when it broke would be one nobody could fix.
  const decidable = plugin.status !== "error"

  return (
    <div
      data-testid={`plugin-row-${plugin.id}`}
      className="flex min-h-[56px] flex-wrap items-center gap-x-3 gap-y-2 rounded-[13px] px-3 py-2.5 transition-colors duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-quaternary)]"
    >
      <PluginIdentity plugin={plugin} />

      <span className="flex flex-none items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label={`Open the ${plugin.name} folder`} onClick={onReveal} className="size-[34px] min-h-0 text-[var(--text-tertiary)]">
          <FolderOpen size={15} aria-hidden />
        </Button>
        {/* The switch's width is held whether or not there is a switch, so the
            reveal buttons stay in one column down the list. */}
        <span className="flex w-[44px] flex-none justify-end">
          {decidable && (
            <ToggleSwitch
              checked={plugin.status === "loaded"}
              onChange={onToggle}
              ariaLabel={plugin.status === "loaded" ? `Disable ${plugin.name}` : `Enable ${plugin.name}`}
            />
          )}
        </span>
      </span>
    </div>
  )
}
