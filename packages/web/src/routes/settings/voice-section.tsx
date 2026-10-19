import { useState } from "react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { OrbVariantPicker } from "@/components/talk/orb-variant-picker"
import type { OrbIntensity } from "@/components/talk/orb-motion"
import type { OrbVariant } from "@/components/talk/orb-motion"
import type { TalkCapability } from "@/lib/talk-capability"
import { useSettings } from "@/routes/settings-provider"
import { FieldRow, Section, SettingsInput, SettingsSelect } from "./shared"
import {
  ModelField,
  NoiseReductionField,
  TurnDetectionField,
  VoiceField,
  type TurnDetection,
} from "./voice-realtime-fields"

/**
 * The `realtime` block, as a settings section.
 *
 * Voice is the one gateway-backed setting whose value this page is never given:
 * `GET /api/config` hands back a sentinel in place of the key, and `PUT`
 * restores the stored key wherever it sees that sentinel come back. So the key
 * is shown as a state — stored, or not — with a way to replace it, and never as
 * a value in a field.
 */

/** What `GET /api/config` returns in place of a stored secret, and what a save
 *  must send back for the gateway to leave that secret alone. */
const REDACTED = "***"

interface VoiceSectionProps {
  provider: string
  apiKey: string
  model: string
  voice: string
  turnDetection: TurnDetection
  noiseReduction: string
  /** Null while the probe is in flight: the section claims nothing about
   *  readiness until it knows. */
  capability: TalkCapability | null
  onChange: (path: string[], value: unknown) => void
  /** Whether the orb is switched on, which decides which way to cross-reference. */
  talkOrbOn: boolean
}

/** What the operator most needs to know, in one line: whether the orb will work. */
function readiness(capability: TalkCapability | null, provider: string, apiKey: string): string | null {
  if (!capability || capability.configured) return null
  if (!provider) return "Pick a provider and add a key to let the orb open a session."
  if (apiKey === REDACTED) {
    return "A key is stored but does not resolve. If it names an environment variable, check that the variable is set where the gateway runs."
  }
  return "Add a key to finish setting this up."
}

/** The key as a state rather than a value: stored, or a field to put one in. */
function KeyField({
  stored,
  apiKey,
  onReplace,
  onChange,
}: {
  stored: boolean
  apiKey: string
  onReplace: () => void
  onChange: (path: string[], value: unknown) => void
}) {
  if (!stored) {
    return (
      <SettingsInput
        type="password"
        ariaLabel="Voice API key"
        value={apiKey}
        onChange={(value) => onChange(["realtime", "apiKey"], value)}
        placeholder="sk-… or ${OPENAI_API_KEY}"
      />
    )
  }
  return (
    <div className="flex items-center justify-between gap-[var(--space-3)] sm:justify-end">
      <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">Stored</span>
      <Button variant="secondary" size="sm" onClick={onReplace}>
        Replace
      </Button>
    </div>
  )
}

/** The lines under the fields: how to write a key, and what is still missing. */
/** Sits directly under the API key row, because it is about the key: where it
 *  may live, and the way back if replacing it was a misclick. */
function KeyGuidance({
  replacing,
  stored,
  onKeepCurrent,
}: {
  replacing: boolean
  stored: boolean
  onKeepCurrent: () => void
}) {
  return (
    <div className="mb-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
      Paste the key, or name an environment variable to read it from and keep it
      out of the config file.
      {replacing && !stored && (
        <>
          {" "}
          <Button variant="link" size="xs" className="h-auto px-0 align-baseline md:h-auto" onClick={onKeepCurrent}>
            Keep the current key
          </Button>
        </>
      )}
    </div>
  )
}

/** What is true of the section as a whole, so it stays at the end. */
function Guidance({
  note,
  talkOrbOn,
}: {
  note: string | null
  talkOrbOn: boolean
}) {
  return (
    <>
      {note && (
        <div className="mt-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
          {note}
        </div>
      )}

      {!talkOrbOn && (
        <div className="mt-[var(--space-3)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          The Talk Orb is switched off in Appearance, so nothing is showing it yet.
        </div>
      )}
    </>
  )
}

function ProviderField({
  provider,
  capability,
  onChange,
}: Pick<VoiceSectionProps, "provider" | "capability" | "onChange">) {
  return (
    <FieldRow label="Provider">
      <SettingsSelect
        ariaLabel="Voice provider"
        value={provider}
        onChange={(value) => onChange(["realtime", "provider"], value || null)}
        options={[
          { value: "", label: "Not set" },
          ...(capability?.providers ?? []).map((name) => ({ value: name, label: name })),
        ]}
      />
    </FieldRow>
  )
}

function OrbMotionField({
  intensity,
  onChange,
}: {
  intensity: OrbIntensity
  onChange: (intensity: OrbIntensity) => void
}) {
  return (
    <FieldRow label="Orb motion">
      <SettingsSelect
        ariaLabel="Talk orb motion"
        value={intensity}
        onChange={(value) => onChange(value as OrbIntensity)}
        options={[
          { value: "calm", label: "Calm" },
          { value: "standard", label: "Standard" },
          { value: "lively", label: "Lively" },
        ]}
      />
    </FieldRow>
  )
}

function OrbStyleField({
  variant,
  onChange,
}: {
  variant: OrbVariant
  onChange: (variant: OrbVariant) => void
}) {
  return (
    <div className="mt-[var(--space-4)]">
      <div className="mb-[var(--space-2)] flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-footnote)] font-medium text-[var(--text-primary)]">
          Orb style
        </span>
        <Link to="/talk-orb" className="text-[length:var(--text-caption1)] text-[var(--system-blue)] no-underline">
          Preview all states
        </Link>
      </div>
      <OrbVariantPicker value={variant} onChange={onChange} />
    </div>
  )
}

/** The three `realtime` fields that shape a session once the provider and key
 *  are settled. Grouped so the section reads as key, then session, then taste. */
function SessionFields({
  voice,
  turnDetection,
  noiseReduction,
  capability,
  onChange,
}: {
  voice: string
  turnDetection: TurnDetection
  noiseReduction: string
  capability: TalkCapability | null
  onChange: (path: string[], value: unknown) => void
}) {
  return (
    <>
      <VoiceField voice={voice} capability={capability} onChange={onChange} />
      <TurnDetectionField turnDetection={turnDetection} onChange={onChange} />
      <NoiseReductionField noiseReduction={noiseReduction} onChange={onChange} />
    </>
  )
}

/**
 * The knobs that are taste rather than configuration: they live in this
 * browser's settings, not in config.yaml, so they read their own store instead
 * of being threaded through the section's props.
 */
function OrbTasteFields() {
  const { settings, setTalkOrbVariant, setTalkOrbIntensity } = useSettings()
  return (
    <>
      <OrbMotionField intensity={settings.talkOrbIntensity} onChange={setTalkOrbIntensity} />
      <OrbStyleField variant={settings.talkOrbVariant} onChange={setTalkOrbVariant} />
    </>
  )
}

export function VoiceSection(props: VoiceSectionProps) {
  const { provider, apiKey, model, capability, onChange, talkOrbOn } = props
  // Replacing is a decision the operator makes here, not something the config
  // can be read for: an emptied field and a gateway with no key look the same.
  const [replacing, setReplacing] = useState(false)
  const stored = apiKey === REDACTED

  function replace() {
    setReplacing(true)
    onChange(["realtime", "apiKey"], "")
  }

  function keepCurrent() {
    setReplacing(false)
    onChange(["realtime", "apiKey"], REDACTED)
  }

  return (
    <Section title="Voice">
      <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
        The speech-to-speech provider the Talk orb opens its sessions with.
      </div>

      <ProviderField provider={provider} capability={capability} onChange={onChange} />
      <ModelField model={model} onChange={onChange} />

      <FieldRow label="API key">
        <KeyField stored={stored} apiKey={apiKey} onReplace={replace} onChange={onChange} />
      </FieldRow>
      <KeyGuidance replacing={replacing} stored={stored} onKeepCurrent={keepCurrent} />

      <SessionFields {...props} />
      <OrbTasteFields />

      <Guidance note={readiness(capability, provider, apiKey)} talkOrbOn={talkOrbOn} />
    </Section>
  )
}
