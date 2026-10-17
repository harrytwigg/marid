import { isOrbIntensity, isOrbVariant, type OrbIntensity, type OrbVariant } from "@/components/talk/orb-motion"

export interface EmployeeOverride {
  emoji?: string
  profileImage?: string
}

export interface TextScaleStep {
  label: string
  value: number
}

/** The shipped text-size steps. Discrete rather than a free slider so the range
 *  stays one nobody can land outside of: 0.9 is where captions stop being
 *  readable and 1.25 is where the sidebar stops fitting its labels. The blocking
 *  bootstrap in index.html mirrors these values — it cannot import them. */
export const TEXT_SCALES: readonly TextScaleStep[] = [
  { label: "Small", value: 0.9 },
  { label: "Default", value: 1 },
  { label: "Large", value: 1.1 },
  { label: "Larger", value: 1.25 },
]

export function isTextScale(value: unknown): value is number {
  return TEXT_SCALES.some((step) => step.value === value)
}

export type Transparency = "full" | "reduced"

export const TRANSPARENCIES: readonly { label: string; value: Transparency }[] = [
  { label: "Full", value: "full" },
  { label: "Reduced", value: "reduced" },
]

export function isTransparency(value: unknown): value is Transparency {
  return value === "full" || value === "reduced"
}

export interface JinnSettings {
  accentColor: string | null
  companyName: string | null
  portalName: string | null
  portalSubtitle: string | null
  portalEmoji: string | null
  portalIcon: string | null
  iconBgHidden: boolean
  emojiOnly: boolean
  operatorName: string | null
  operatorEmoji: string | null
  language: string
  /** The floating Talk orb. Off until something is there for it to talk to. */
  talkOrb: boolean
  /** The persisted visual strategy for the floating Talk control. */
  talkOrbVariant: OrbVariant
  /** How much the orb is allowed to move. Taste, not accessibility — reduced
   *  motion is honoured regardless of what this says. */
  talkOrbIntensity: OrbIntensity
  /** Multiplier on every type step. Per-device on purpose — it tracks the screen
   *  being read, not the account. */
  textScale: number
  /** "reduced" swaps every glass surface for its opaque twin. "full" leaves the
   *  choice to the OS, whose reduced-transparency preference applies either way. */
  transparency: Transparency
  employeeOverrides: Record<string, EmployeeOverride>
}

export const DEFAULTS: JinnSettings = {
  accentColor: null,
  companyName: null,
  portalName: null,
  portalSubtitle: null,
  portalEmoji: null,
  portalIcon: null,
  iconBgHidden: false,
  emojiOnly: false,
  operatorName: null,
  operatorEmoji: null,
  language: "English",
  talkOrb: false,
  talkOrbVariant: "mist",
  talkOrbIntensity: "standard",
  textScale: 1,
  transparency: "full",
  employeeOverrides: {},
}

const STORAGE_KEY = 'jinn-settings'

export function loadSettings(): JinnSettings {
  if (typeof window === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULTS, ...parsed } as JinnSettings
    if (!isOrbVariant(merged.talkOrbVariant)) merged.talkOrbVariant = DEFAULTS.talkOrbVariant
    if (!isOrbIntensity(merged.talkOrbIntensity)) merged.talkOrbIntensity = DEFAULTS.talkOrbIntensity
    if (!isTextScale(merged.textScale)) merged.textScale = DEFAULTS.textScale
    if (!isTransparency(merged.transparency)) merged.transparency = DEFAULTS.transparency
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: JinnSettings): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function hexToAccentFill(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},0.15)`
}

export function hexToContrastText(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const lum = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  return lum > 0.4 ? '#000' : '#fff'
}
