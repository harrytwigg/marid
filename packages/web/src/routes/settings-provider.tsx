import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import {
  type JinnSettings,
  type EmployeeOverride,
  DEFAULTS,
  loadSettings,
  saveSettings,
} from '@/lib/settings'
import { useOnboarding } from '@/hooks/use-onboarding'
import { useRootCssVariables } from '@/hooks/use-root-css-variables'
import { PRODUCT_NAME } from "@/lib/brand"

interface EmployeeDisplay {
  emoji: string
  profileImage?: string
  emojiOnly?: boolean
}

interface SettingsContextValue {
  settings: JinnSettings
  setAccentColor: (color: string | null) => void
  setCompanyName: (name: string | null) => void
  setPortalName: (name: string | null) => void
  setPortalSubtitle: (subtitle: string | null) => void
  setPortalEmoji: (emoji: string | null) => void
  setPortalIcon: (icon: string | null) => void
  setIconBgHidden: (hidden: boolean) => void
  setEmojiOnly: (emojiOnly: boolean) => void
  setOperatorName: (name: string | null) => void
  setOperatorEmoji: (emoji: string | null) => void
  setLanguage: (language: string) => void
  setTalkOrb: (enabled: boolean) => void
  setTalkOrbVariant: (variant: JinnSettings["talkOrbVariant"]) => void
  setTalkOrbIntensity: (intensity: JinnSettings["talkOrbIntensity"]) => void
  setTextScale: (textScale: JinnSettings["textScale"]) => void
  setEmployeeOverride: (employeeId: string, override: EmployeeOverride) => void
  clearEmployeeOverride: (employeeId: string) => void
  getEmployeeDisplay: (employee: { name: string; emoji: string; id: string }) => EmployeeDisplay
  resetAll: () => void
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: { ...DEFAULTS },
  setAccentColor: () => {},
  setCompanyName: () => {},
  setPortalName: () => {},
  setPortalSubtitle: () => {},
  setPortalEmoji: () => {},
  setPortalIcon: () => {},
  setIconBgHidden: () => {},
  setEmojiOnly: () => {},
  setOperatorName: () => {},
  setOperatorEmoji: () => {},
  setLanguage: () => {},
  setTalkOrb: () => {},
  setTalkOrbVariant: () => {},
  setTalkOrbIntensity: () => {},
  setTextScale: () => {},
  setEmployeeOverride: () => {},
  clearEmployeeOverride: () => {},
  getEmployeeDisplay: (employee) => ({ emoji: employee.emoji }),
  resetAll: () => {},
})

type SettingsUpdate = (next: (prev: JinnSettings) => JinnSettings) => void

/** One field, set as itself. For knobs whose value needs no coercion. */
function useField<K extends keyof JinnSettings>(
  update: SettingsUpdate,
  key: K,
): (value: JinnSettings[K]) => void {
  return useCallback((value: JinnSettings[K]) => {
    update((prev) => ({ ...prev, [key]: value }))
  }, [update, key])
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  // Read localStorage during the first render rather than in a mount effect.
  // The blocking bootstrap in index.html has already painted at the stored text
  // scale, so a first pass holding the defaults would publish --text-scale: 1
  // over it and reflow the whole page before the effect corrected it. There is
  // no server render to mismatch: main.tsx mounts with createRoot into the
  // empty #root that index.html ships. loadSettings() returns the defaults when
  // window is absent, so a non-browser render still gets them.
  const [settings, setSettings] = useState<JinnSettings>(loadSettings)

  // Onboarding status/names come from the shared react-query key so the whole
  // app fires exactly one /api/onboarding request (the wizard consumes it too).
  const { data: onboarding } = useOnboarding()

  // Sync companyName/portalName/operatorName/operatorEmoji from backend config
  // (source of truth) once the shared onboarding query resolves. This ensures the
  // correct COO name and operator icon show up even if localStorage has stale
  // values from a previous onboarding or another browser.
  useEffect(() => {
    if (!onboarding) return
    setSettings((prev) => {
      const merged = {
        ...prev,
        ...(onboarding.companyName ? { companyName: onboarding.companyName } : {}),
        ...(onboarding.portalName ? { portalName: onboarding.portalName } : {}),
        ...(onboarding.operatorName ? { operatorName: onboarding.operatorName } : {}),
        // The emoji lives only in gateway config, so an absent one means unset —
        // it has to clear a stale local value rather than leave it standing.
        operatorEmoji: onboarding.operatorEmoji ?? null,
      }
      if (
        merged.companyName === prev.companyName &&
        merged.portalName === prev.portalName &&
        merged.operatorName === prev.operatorName &&
        merged.operatorEmoji === prev.operatorEmoji
      ) {
        return prev
      }
      saveSettings(merged)
      return merged
    })
  }, [onboarding])

  useRootCssVariables(settings)

  const update = useCallback((updater: (prev: JinnSettings) => JinnSettings) => {
    setSettings((prev) => {
      const next = updater(prev)
      saveSettings(next)
      return next
    })
  }, [])

  const setAccentColor = useCallback(
    (color: string | null) => {
      update((prev) => ({ ...prev, accentColor: color }))
    },
    [update],
  )
  const setPortalName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, portalName: name || null }))
    },
    [update],
  )
  const setCompanyName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, companyName: name || null }))
    },
    [update],
  )
  const setPortalSubtitle = useCallback(
    (subtitle: string | null) => {
      update((prev) => ({ ...prev, portalSubtitle: subtitle || null }))
    },
    [update],
  )
  const setPortalEmoji = useCallback(
    (emoji: string | null) => {
      update((prev) => ({ ...prev, portalEmoji: emoji || null }))
    },
    [update],
  )
  const setPortalIcon = useCallback(
    (icon: string | null) => {
      update((prev) => ({ ...prev, portalIcon: icon }))
    },
    [update],
  )
  const setIconBgHidden = useCallback(
    (hidden: boolean) => {
      update((prev) => ({ ...prev, iconBgHidden: hidden }))
    },
    [update],
  )
  const setEmojiOnly = useCallback(
    (emojiOnly: boolean) => {
      update((prev) => ({ ...prev, emojiOnly }))
    },
    [update],
  )
  const setOperatorName = useCallback(
    (name: string | null) => {
      update((prev) => ({ ...prev, operatorName: name || null }))
    },
    [update],
  )
  const setOperatorEmoji = useCallback(
    (emoji: string | null) => {
      update((prev) => ({ ...prev, operatorEmoji: emoji || null }))
    },
    [update],
  )
  const setLanguage = useCallback(
    (language: string) => {
      update((prev) => ({ ...prev, language: language || "English" }))
    },
    [update],
  )
  // The Talk knobs are all the same setter with a different key, so they are
  // written once. The ones above coerce their input and stay spelled out.
  const setTalkOrb = useField(update, "talkOrb")
  const setTalkOrbVariant = useField(update, "talkOrbVariant")
  const setTalkOrbIntensity = useField(update, "talkOrbIntensity")

  const setTextScale = useCallback(
    (textScale: JinnSettings["textScale"]) => {
      update((prev) => ({ ...prev, textScale }))
    },
    [update],
  )

  const setEmployeeOverride = useCallback(
    (employeeId: string, override: EmployeeOverride) => {
      update((prev) => {
        const existing = prev.employeeOverrides[employeeId] || {}
        return {
          ...prev,
          employeeOverrides: {
            ...prev.employeeOverrides,
            [employeeId]: { ...existing, ...override },
          },
        }
      })
    },
    [update],
  )

  const clearEmployeeOverride = useCallback(
    (employeeId: string) => {
      update((prev) => {
        const { [employeeId]: _, ...rest } = prev.employeeOverrides
        return { ...prev, employeeOverrides: rest }
      })
    },
    [update],
  )

  const getEmployeeDisplay = useCallback(
    (employee: { name: string; emoji: string; id: string }): EmployeeDisplay => {
      const override = settings.employeeOverrides[employee.id]
      return {
        emoji: override?.emoji || employee.emoji,
        profileImage: override?.profileImage,
        emojiOnly: settings.emojiOnly,
      }
    },
    [settings.employeeOverrides, settings.emojiOnly],
  )

  const resetAll = useCallback(() => {
    update(() => ({ ...DEFAULTS }))
  }, [update])

  return (
    <SettingsContext.Provider
      value={{
        settings,
        setAccentColor,
        setCompanyName,
        setPortalName,
        setPortalSubtitle,
        setPortalEmoji,
        setPortalIcon,
        setIconBgHidden,
        setEmojiOnly,
        setOperatorName,
        setOperatorEmoji,
        setLanguage,
        setTalkOrb,
        setTalkOrbVariant,
        setTalkOrbIntensity,
        setTextScale,
        setEmployeeOverride,
        clearEmployeeOverride,
        getEmployeeDisplay,
        resetAll,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)

/** Sets document.title from the portal name setting. One-time write per change —
 *  no MutationObserver (it raced with the other writers of the title). */
export function DocumentTitle() {
  const { settings } = useSettings()

  useEffect(() => {
    const name = settings.portalName || PRODUCT_NAME
    const desired = name
    if (document.title !== desired) {
      document.title = desired
    }
  }, [settings.portalName])

  return null
}
