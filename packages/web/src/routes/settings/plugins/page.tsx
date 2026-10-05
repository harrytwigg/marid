import { RefreshCw } from "lucide-react"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { PluginList } from "./plugin-list"
import {
  useInventoryFollowsDisk,
  useRescanPlugins,
  useRevealPlugin,
  useTogglePlugin,
  usePluginInventory,
} from "./inventory"

/* The operator's view of `~/.jinn/plugins/`. It renders the INVENTORY rather
 * than the enabled subset, so a disabled or broken plugin is still something
 * you can see and act on. Header, row, refresh control and skeleton ladder are
 * the Cron page's, because this is the same kind of list: things the company
 * runs, each with one switch. */

function Header({ installed, enabled, busy, onRescan }: {
  installed: number | null
  enabled: number
  busy: boolean
  onRescan: () => void
}) {
  return (
    <LargeTitleHeader
      title="Plugins"
      subtitle={
        installed === null
          ? "Everything installed in this workspace, and what you have let run"
          : `${installed} installed · ${enabled} enabled`
      }
      trailing={
        <button
          type="button"
          aria-label="Rescan the plugins folder"
          onClick={onRescan}
          className="grid size-[34px] place-items-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <RefreshCw size={14} strokeWidth={2.2} className={busy ? "animate-spin" : undefined} aria-hidden />
        </button>
      }
    />
  )
}

/** The gateway's refusal, in the operator's way rather than only the console's. */
function ActionError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      data-testid="plugins-action-error"
      className="mb-3.5 rounded-[var(--radius-lg)] p-3.5 text-[length:var(--text-footnote)] text-[var(--system-red)]"
      style={{ background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }}
    >
      {error.message}
    </div>
  )
}

export default function PluginsSettingsPage() {
  const inventory = usePluginInventory()
  const toggle = useTogglePlugin()
  const reveal = useRevealPlugin()
  const rescan = useRescanPlugins()
  useInventoryFollowsDisk()

  const plugins = inventory.data ?? []
  const failure = [toggle.error, reveal.error, rescan.error].find(Boolean)

  return (
    <PageLayout>
      <PageScaffold
        contentWidth="840px"
        header={
          <Header
            installed={inventory.isSuccess ? plugins.length : null}
            enabled={plugins.filter((plugin) => plugin.status === "loaded").length}
            busy={rescan.isPending || inventory.isFetching}
            onRescan={() => rescan.mutate()}
          />
        }
      >
        <div>

          <div>
            {failure && <ActionError error={failure} />}
            <PluginList
              inventory={inventory}
              onToggle={(id, enabled) => toggle.mutate({ id, enabled })}
              onReveal={(id) => reveal.mutate(id)}
            />
            <p className="mt-3.5 px-1 text-[length:var(--text-caption1)] leading-relaxed text-[var(--text-tertiary)]">
              An enabled plugin runs with the same authority the dashboard and the gateway have. Enable only the ones
              you trust, the way you would a shell script.
            </p>
          </div>
        </div>
      </PageScaffold>
    </PageLayout>
  )
}
