import { useEffect, useRef, useState } from "react"
import { PRODUCT_EMOJI } from "@/lib/brand"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { useSettings } from "@/routes/settings-provider"
import { CONTROL_CLASS } from "./shared"

/* The two identity emoji controls in Branding. Each owns its picker state, so
 * the settings page carries one line per row instead of the whole popover. */

const LABEL_CLASS = "block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
const SWATCH_CLASS =
  "flex size-[44px] cursor-pointer items-center justify-center rounded-[13px] border-none bg-[var(--fill-quaternary)] text-[26px] leading-none transition-colors hover:bg-[var(--fill-tertiary)]"

const PORTAL_DEFAULT_EMOJI = PRODUCT_EMOJI
const ERROR_CLASS =
  "mt-[var(--space-2)] rounded-[var(--radius-lg)] p-[8px_10px] text-[length:var(--text-caption1)] text-[var(--system-red)]"
const ERROR_WASH = { background: "color-mix(in srgb, var(--system-red) 8%, transparent)" }

/** The icon on the operator's own comments and messages. Persisted in gateway
 *  config rather than localStorage, so it follows them to any browser. */
export function OperatorEmojiRow() {
  const { settings, setOperatorEmoji } = useSettings()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const latestSave = useRef(0)
  const current = settings.operatorEmoji ?? OPERATOR_DEFAULT_EMOJI

  const choose = (emoji: string) => {
    const previous = settings.operatorEmoji
    const save = ++latestSave.current
    setOperatorEmoji(emoji)
    setSaveError(null)
    setPickerOpen(false)
    // The gateway owns this setting, so a rejected write has to take the local
    // one back with it — otherwise the swatch shows a pick no browser will see.
    // Only the newest write may do that: an older one losing a race would undo
    // a pick the operator has since made and the gateway has since accepted.
    api.completeOnboarding({ operatorEmoji: emoji }).catch((err: unknown) => {
      if (save !== latestSave.current) return
      setOperatorEmoji(previous)
      setSaveError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <div>
      <label className={LABEL_CLASS}>Operator Emoji</label>
      <div className="relative flex items-center">
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-label="Choose operator emoji"
          aria-expanded={pickerOpen}
          className={SWATCH_CLASS}
        >
          {current}
        </button>
        {pickerOpen && (
          <EmojiPicker current={current} onSelect={choose} onClose={() => setPickerOpen(false)} />
        )}
      </div>
      {saveError && (
        <p role="alert" className={ERROR_CLASS} style={ERROR_WASH}>
          Could not save the operator emoji: {saveError}. It is unchanged. Check that the gateway
          is running and pick again.
        </p>
      )}
    </div>
  )
}

/** One control instead of the old duplicate pair (a picker section + a raw text
 *  input both writing the same setting). The button opens the searchable picker;
 *  the small field still accepts free-form marks (letters, custom glyphs). */
export function PortalEmojiRow() {
  const { settings, setPortalEmoji } = useSettings()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [draft, setDraft] = useState(settings.portalEmoji ?? "")
  const current = settings.portalEmoji ?? PORTAL_DEFAULT_EMOJI

  useEffect(() => {
    setDraft(settings.portalEmoji ?? "")
  }, [settings.portalEmoji])

  return (
    <div>
      <label className={LABEL_CLASS}>Portal Emoji</label>
      <div className="relative flex items-center gap-[var(--space-3)]">
        <button
          type="button"
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-label="Choose portal emoji"
          aria-expanded={pickerOpen}
          className={SWATCH_CLASS}
        >
          {current}
        </button>
        <input
          type="text"
          className={cn(CONTROL_CLASS, "w-[96px] text-center")}
          placeholder={`${PRODUCT_EMOJI}\u{FE0F}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setPortalEmoji(draft || null)}
        />
        {pickerOpen && (
          <EmojiPicker
            current={current}
            onSelect={(emoji) => {
              setPortalEmoji(emoji)
              setPickerOpen(false)
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
