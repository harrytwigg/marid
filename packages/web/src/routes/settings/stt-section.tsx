import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { CONTROL_CLASS, Section } from "./shared"

// ---------------------------------------------------------------------------
// Whisper STT language list (curated top ~35)
// ---------------------------------------------------------------------------

const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
}

/** The languages still on offer, named, in the order they are shown. */
function unusedLanguages(chosen: string[]): [string, string][] {
  return Object.entries(WHISPER_LANGUAGES)
    .filter(([code]) => !chosen.includes(code))
    .sort((a, b) => a[1].localeCompare(b[1]))
}

interface SttStatus {
  available: boolean
  model: string | null
  downloading: boolean
  progress: number
  languages: string[]
}

/** Whether a model is installed, and which one. */
function StatusRow({ status }: { status: SttStatus }) {
  return (
    <div className="flex items-center gap-[var(--space-3)] mb-[var(--space-4)]">
      <div
        className="w-[8px] h-[8px] rounded-full shrink-0"
        style={{
          background: status.available ? "var(--system-green)" : "var(--system-red)",
        }}
      />
      <div className="flex-1">
        <div className="text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">
          {status.available
            ? `Whisper ${(status.model || "small").charAt(0).toUpperCase() + (status.model || "small").slice(1)}`
            : "No model installed"}
        </div>
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {status.available
            ? "Offline speech recognition ready"
            : "Download a model to enable voice input"}
        </div>
      </div>
    </div>
  )
}

/** The download offer, or the bar it turns into once one is running. */
function DownloadRow({ status, onDownload }: { status: SttStatus; onDownload: () => void }) {
  if (status.downloading) {
    return (
      <div className="mb-[var(--space-4)]">
        <div className="flex justify-between mb-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          <span>Downloading model…</span>
          <span>{status.progress}%</span>
        </div>
        <div className="h-[6px] rounded-[3px] bg-[var(--fill-tertiary)] overflow-hidden">
          <div
            className="h-full rounded-[3px] bg-[var(--accent)] transition-[width] duration-300 ease-out"
            style={{
              width: `${status.progress}%`,
            }}
          />
        </div>
      </div>
    )
  }
  if (status.available) return null
  return (
    <button
      onClick={onDownload}
      className="w-full p-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-footnote)] font-[var(--weight-semibold)] mb-[var(--space-4)]" // jinn-shell: ok settings download control, not page chrome
    >
      Download Whisper Small (~500MB)
    </button>
  )
}

/** One chip per selected language; the first is the default. */
function LanguageChips({
  languages,
  saving,
  onRemove,
}: {
  languages: string[]
  saving: boolean
  onRemove: (code: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-[var(--space-2)] mb-[var(--space-3)]">
      {languages.map((code) => (
        <div
          key={code}
          className="inline-flex items-center gap-[var(--space-1)] px-[8px] py-[3px] rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-primary)]"
        >
          <span className="font-[family-name:var(--font-mono)] uppercase text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] mr-[2px]">
            {code}
          </span>
          {WHISPER_LANGUAGES[code] || code}
          {languages.length > 1 && (
            <button
              onClick={() => onRemove(code)}
              disabled={saving}
              aria-label={`Remove ${WHISPER_LANGUAGES[code] || code}`}
              className="bg-none border-none cursor-pointer p-0 ml-[2px] text-[var(--text-quaternary)] text-[14px] leading-none flex items-center"
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

/** The picker that adds one, disabled until something is picked. */
function AddLanguageRow({
  addLang,
  setAddLang,
  available,
  saving,
  onAdd,
}: {
  addLang: string
  setAddLang: (code: string) => void
  available: [string, string][]
  saving: boolean
  onAdd: () => void
}) {
  return (
    <div className="flex gap-[var(--space-2)]">
      <select
        aria-label="Language to add"
        value={addLang}
        onChange={(e) => setAddLang(e.target.value)}
        className={cn(CONTROL_CLASS, "flex-1 cursor-pointer")}
        style={{
          color: addLang ? "var(--text-primary)" : "var(--text-tertiary)",
        }}
      >
        <option value="">Add a language…</option>
        {available.map(([code, name]) => (
          <option key={code} value={code}>
            {code.toUpperCase()} — {name}
          </option>
        ))}
      </select>
      <button
        onClick={onAdd}
        disabled={!addLang || saving}
        className="px-[14px] py-[6px] rounded-[var(--radius-sm)] border-none text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shrink-0"
        style={{
          background: addLang ? "var(--accent)" : "var(--fill-tertiary)",
          color: addLang ? "var(--accent-contrast)" : "var(--text-quaternary)",
          cursor: addLang ? "pointer" : "default",
        }}
      >
        Add
      </button>
    </div>
  )
}

/** The language editor, shown only once a model is installed. */
function LanguageEditor({ stt }: { stt: SttSection }) {
  return (
    <div className="border-t border-[var(--separator)] mt-[var(--space-2)] pt-[var(--space-3)]">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
        Transcription Languages
      </div>
      <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
        First language is the default. Add multiple to show a language picker in chat.
      </div>
      <LanguageChips languages={stt.status!.languages} saving={stt.saving} onRemove={stt.removeLanguage} />
      <AddLanguageRow
        addLang={stt.addLang}
        setAddLang={stt.setAddLang}
        available={stt.availableLanguages}
        saving={stt.saving}
        onAdd={stt.addLanguage}
      />
    </div>
  )
}

interface SttSection {
  status: SttStatus | null
  saving: boolean
  addLang: string
  setAddLang: (code: string) => void
  availableLanguages: [string, string][]
  removeLanguage: (code: string) => void
  addLanguage: () => void
  download: () => void
}

/**
 * Everything the STT section does that is not markup. It owns its own state and
 * saves through its own endpoint rather than the page's config write, because these
 * are `/api/stt/*` routes rather than part of the gateway config document.
 */
function useSttSection(): SttSection {
  const [status, setStatus] = useState<SttStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [addLang, setAddLang] = useState("")

  useEffect(() => {
    api.sttStatus().then(setStatus).catch(() => {})
  }, [])

  // Poll for download progress
  useEffect(() => {
    if (!status?.downloading) return
    const timer = setInterval(() => {
      api.sttStatus().then(setStatus).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [status?.downloading])

  function saveLanguages(next: string[]) {
    setSaving(true)
    api.sttUpdateConfig(next)
      .then(() => setStatus((prev) => prev ? { ...prev, languages: next } : prev))
      .catch(() => {})
      .finally(() => setSaving(false))
  }

  return {
    status,
    saving,
    addLang,
    setAddLang,
    availableLanguages: unusedLanguages(status?.languages ?? []),
    removeLanguage(code: string) {
      if (!status || status.languages.length <= 1) return
      saveLanguages(status.languages.filter((l) => l !== code))
    },
    addLanguage() {
      if (!addLang || !status || status.languages.includes(addLang)) return
      const next = [...status.languages, addLang]
      setAddLang("")
      saveLanguages(next)
    },
    download() {
      api.sttDownload()
        .then(() => setStatus((prev) => prev ? { ...prev, downloading: true, progress: 0 } : prev))
        .catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// Voice Input (STT) settings section — self-contained state
// ---------------------------------------------------------------------------

export function SttSettingsSection() {
  const stt = useSttSection()
  if (!stt.status) return null

  return (
    <Section title="Voice Input">
      <StatusRow status={stt.status} />
      <DownloadRow status={stt.status} onDownload={stt.download} />
      {stt.status.available && <LanguageEditor stt={stt} />}
    </Section>
  )
}
