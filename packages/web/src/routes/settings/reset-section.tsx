import { RotateCcw, Trash2 } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import { Section } from "./shared"

export function ResetSection({ resetAll }: { resetAll: () => void }) {
  // Destructive actions use a quiet red wash rather than a solid alarm block.
  return (
    <Section title="Reset">
      <div
        className="flex flex-wrap items-center gap-[var(--space-3)]"
      >
        <Button
          variant="secondary"
          onClick={() => {
            localStorage.removeItem("jinn-onboarded")
            window.location.reload()
          }}
        >
          <RotateCcw size={15} />
          Re-run Onboarding
        </Button>
        <Button
          variant="ghost"
          className="text-[var(--system-red)] [--button-bg:color-mix(in_srgb,var(--system-red)_8%,transparent)] [--button-bg-hover:color-mix(in_srgb,var(--system-red)_14%,transparent)]"
          onClick={() => {
            if (
              window.confirm("Reset all settings to defaults?")
            ) {
              localStorage.removeItem("jinn-settings")
              localStorage.removeItem("jinn-theme")
              resetAll()
              window.location.reload()
            }
          }}
        >
          <Trash2 size={15} />
          Reset All Settings
        </Button>
      </div>
    </Section>
  )
}
