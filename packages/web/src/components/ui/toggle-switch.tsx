import { Switch } from "@/components/ui/switch"

/**
 * The enable/disable switch the settings pages use: green when on, and a press
 * target taller than the track. The track is 24px, which is too small to hit
 * with a thumb, so the control around it is 40px tall on a phone and 34px from
 * the md breakpoint up, and 44px wide. The press lands on that box, not on the
 * track.
 */
export const TOGGLE_SWITCH_TARGET = "min-h-[40px] min-w-[44px] justify-center md:min-h-[34px]"

export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  onClick,
  targetClassName = TOGGLE_SWITCH_TARGET,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label?: string
  /** A switch mid-write: not clickable and not keyboard-toggleable either. */
  disabled?: boolean
  /** For a switch inside a clickable row: stop the click before the row sees it. */
  onClick?: (event: React.MouseEvent<HTMLElement>) => void
  /** Only for a row that cannot grow to the full target; the settings pages keep the default. */
  targetClassName?: string
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
      className="[--switch-control-bg-checked:var(--system-green)] [--switch-control-bg-checked-hover:var(--system-green)]"
      targetClassName={targetClassName}
    />
  )
}
