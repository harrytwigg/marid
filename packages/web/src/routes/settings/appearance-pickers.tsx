/** The accent swatches the picker offers, beside the picker that renders them. */
export const ACCENT_PRESETS = [
  { label: "Marid teal", value: "#3DBFB2" },
  { label: "Red", value: "#EF4444" },
  { label: "Orange", value: "#F97316" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Yellow", value: "#EAB308" },
  { label: "Lime", value: "#84CC16" },
  { label: "Green", value: "#22C55E" },
  { label: "Emerald", value: "#10B981" },
  { label: "Cyan", value: "#06B6D4" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Indigo", value: "#6366F1" },
  { label: "Violet", value: "#8B5CF6" },
  { label: "Pink", value: "#EC4899" },
]

import { TEXT_SCALES } from "@/lib/settings"
import { THEMES } from "@/lib/themes"
import { useTheme } from "@/routes/providers"
import { useSettings } from "@/routes/settings-provider"

/**
 * The Appearance section's two step pickers.
 *
 * Both answer the same question — which one of these few looks do you want —
 * so both are the same control: a glyph, a label, and the accent fill standing
 * in for a selection ring rather than a border at rest.
 */

function PickerLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] mb-[var(--space-2)]">
      {children}
    </div>
  )
}

function StepButton({
  glyph,
  label,
  isActive,
  onClick,
}: {
  glyph: React.ReactNode
  label: string
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className="flex cursor-pointer flex-col items-center gap-[var(--space-1)] rounded-[13px] border-none px-[var(--space-2)] py-[var(--space-3)] transition-colors duration-150 ease-[var(--ease-smooth)]"
      style={{
        background: isActive ? "var(--accent-fill)" : "var(--fill-quaternary)",
      }}
    >
      {glyph}
      <span
        className="text-[length:var(--text-caption2)]"
        style={{
          fontWeight: isActive ? "var(--weight-semibold)" : "var(--weight-medium)",
          color: isActive ? "var(--accent)" : "var(--text-secondary)",
        }}
      >
        {label}
      </span>
    </button>
  )
}

export function ThemePicker() {
  const { theme, setTheme } = useTheme()

  return (
    <>
      <PickerLabel>Theme</PickerLabel>
      <div className="grid grid-cols-3 gap-[var(--space-2)] mb-[var(--space-4)]">
        {THEMES.map((t) => (
          <StepButton
            key={t.id}
            glyph={<span className="text-[24px]">{t.emoji}</span>}
            label={t.label}
            isActive={theme === t.id}
            onClick={() => setTheme(t.id)}
          />
        ))}
      </div>
    </>
  )
}

export function TextSizePicker() {
  const { settings, setTextScale } = useSettings()

  return (
    <>
      <PickerLabel>Text Size</PickerLabel>
      <div className="grid grid-cols-4 gap-[var(--space-2)] mb-[var(--space-4)]">
        {TEXT_SCALES.map((step) => (
          <StepButton
            key={step.value}
            // A fixed rem, deliberately not a scaled token: the preview has to
            // show the four steps against each other, not all four rendered at
            // whichever one is currently selected. The slot is a fixed height so
            // the labels below stay on one line.
            glyph={
              <span
                className="flex h-[30px] items-center leading-none text-[var(--text-primary)]"
                style={{ fontSize: `calc(1.25rem * ${step.value})` }}
              >
                Aa
              </span>
            }
            label={step.label}
            isActive={settings.textScale === step.value}
            onClick={() => setTextScale(step.value)}
          />
        ))}
      </div>
    </>
  )
}
