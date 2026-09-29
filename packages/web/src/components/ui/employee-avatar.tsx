
import { useSettings } from "@/routes/settings-provider"
import { emojiForName } from "@/lib/emoji-pool"
import type { JinnSettings } from "@/lib/settings"

/** The operator's icon before they pick one in Settings. Every install has been
 *  showing this on its own comments, so it stays their default rather than the
 *  name-hashed emoji employees get. */
export const OPERATOR_DEFAULT_EMOJI = "\u{1F308}"

/** Avatar name for a terminal session row: no employee, a screen. */
export const TERMINAL_AVATAR = "__terminal__"

interface EmployeeAvatarProps {
  name: string
  /** Shown when this name has no chosen emoji. Defaults to the name's pool entry. */
  fallback?: string
  size?: number
  fontSize?: number
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

function emojiFor(name: string, fallback: string | undefined, settings: JinnSettings): string {
  // "operator" is the reserved actor kind on the wire, not an employee name, so
  // it resolves from the operator's own setting instead of the employee overrides.
  const chosen = name === "operator" ? settings.operatorEmoji : settings.employeeOverrides[name]?.emoji
  return chosen || fallback || (name === TERMINAL_AVATAR ? "\u{1F5A5}\uFE0F" : emojiForName(name))
}

export function EmployeeAvatar({
  name,
  fallback,
  size = 32,
  fontSize: fontSizeOverride,
  className,
  style,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const emoji = emojiFor(name, fallback, settings)
  const fontSize = fontSizeOverride ?? Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
        ...style,
      }}
    >
      {emoji}
    </span>
  )
}
