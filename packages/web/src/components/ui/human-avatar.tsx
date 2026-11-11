import { initialsOf } from "@/lib/accounts-api"

interface HumanAvatarProps {
  /** The person's display name; the initials come from it unless given. */
  name: string
  initials?: string
  size?: number
  className?: string
}

/** A person, as opposed to an employee (a round emoji) or the operator (their own emoji): initials in a
 *  square-rounded badge, so a glance tells the three apart without reading a name. */
export function HumanAvatar({ name, initials, size = 18, className }: HumanAvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      data-testid="human-avatar"
      title={name}
      className={`inline-flex shrink-0 select-none items-center justify-center bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] font-[var(--weight-semibold)] leading-none text-[var(--accent)] ${className ?? ""}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), fontSize: Math.max(8, Math.round(size * 0.42)) }}
    >
      {initials || initialsOf(name)}
    </span>
  )
}
