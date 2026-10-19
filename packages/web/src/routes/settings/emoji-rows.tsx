import { useEffect, useRef, useState } from "react"
import { BrandMark } from "@/components/brand-mark"
import { customBrandGlyph } from "@/lib/brand"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { EmojiPicker } from "@/components/ui/emoji-picker"
import { OPERATOR_DEFAULT_EMOJI } from "@/components/ui/employee-avatar"
import { useSettings } from "@/routes/settings-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FIELD_CLASS } from "./shared"

/* The two identity emoji controls in Branding. Each owns its picker state, so
 * the settings page carries one line per row instead of the whole popover. */

const LABEL_CLASS = "block text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mb-[var(--space-1)]"
const SWATCH_CLASS = "size-[44px] min-h-0 shrink-0 rounded-[13px] p-0 text-[26px] leading-none"

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
        <Button
          variant="secondary"
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-label="Choose operator emoji"
          aria-expanded={pickerOpen}
          className={SWATCH_CLASS}
        >
          {current}
        </Button>
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
  const current = customBrandGlyph(settings) ?? ""

  useEffect(() => {
    setDraft(settings.portalEmoji ?? "")
  }, [settings.portalEmoji])

  return (
    <div>
      <label className={LABEL_CLASS}>Portal Emoji</label>
      <div className="relative flex items-center gap-[var(--space-3)]">
        <Button
          variant="secondary"
          onClick={() => setPickerOpen(!pickerOpen)}
          aria-label="Choose portal emoji"
          aria-expanded={pickerOpen}
          className={SWATCH_CLASS}
        >
          {current || <BrandMark size={30} />}
        </Button>
        <Input
          type="text"
          className={cn(FIELD_CLASS, "w-[96px] text-center")}
          placeholder="Default"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setPortalEmoji(draft.trim() || null)}
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
