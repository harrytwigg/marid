import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react"
import { KeyRound, LoaderCircle, PlugZap, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import type { NativeGatewayProfile, NativeGatewayProfilesSnapshot } from "@/lib/native-gateway-profiles"
import {
  nativeGatewayProfiles,
  pairAndInstallNativeGateway,
  pairNativeGatewayProfile,
} from "@/lib/native-gateway-bootstrap"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PRODUCT_NAME } from "@/lib/brand"

const INPUT_SHELL =
  "flex h-11 w-full items-center gap-2 rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 shadow-[inset_0_0_0_1px_var(--separator)] transition-[box-shadow] duration-150 [transition-timing-function:var(--ease-smooth)] focus-within:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-fill)]"
const INPUT =
  "min-w-0 flex-1 bg-transparent text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
const LABEL = "text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]"
const PANEL = "rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] p-[var(--space-4)]"
const ACCENT_BUTTON =
  "inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-[var(--space-4)] text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--accent-contrast)] transition-[transform,filter,opacity] duration-150 [transition-timing-function:var(--ease-snappy)] hover:brightness-[1.04] active:scale-[0.96] disabled:opacity-55 disabled:hover:brightness-100 disabled:active:scale-100"
const QUIET_BUTTON =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--accent)] transition-[transform,background-color] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--accent-fill)] active:scale-[0.96] disabled:opacity-45"
const ICON_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] transition-[transform,background-color,color] duration-150 [transition-timing-function:var(--ease-snappy)] hover:bg-[var(--fill-secondary)] hover:text-[var(--system-red)] active:scale-[0.96] disabled:opacity-45"

interface FieldsProps { origin: string; code: string; onOrigin: (value: string) => void; onCode: (value: string) => void }

function PairingField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <label className={LABEL} htmlFor={id}>{label}</label>
      <div className={INPUT_SHELL}>{children}</div>
    </div>
  )
}

function PairingFields({ origin, code, onOrigin, onCode }: FieldsProps) {
  return (
    <div className="flex flex-col gap-[var(--space-3)]">
      <PairingField id="native-gateway-origin" label="Gateway origin">
        <PlugZap size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        <input
          id="native-gateway-origin" className={INPUT} inputMode="url" spellCheck={false} required
          value={origin} onChange={(event) => onOrigin(event.target.value)} placeholder="http://127.0.0.1:7779"
        />
      </PairingField>
      <PairingField id="native-pair-code" label="Pair code">
        <KeyRound size={16} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        <input
          id="native-pair-code" className={`${INPUT} font-[var(--font-code)] uppercase tracking-[0.06em]`} required
          value={code} onChange={(event) => onCode(event.target.value)} autoComplete="one-time-code" placeholder="ABCD-EFGH-JKLM"
        />
      </PairingField>
    </div>
  )
}

function ErrorNote({ message }: { message?: string }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-md)] bg-[color-mix(in_srgb,var(--system-red)_12%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]"
    >
      {message}
    </p>
  )
}

export function NativePairingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [origin, setOrigin] = useState("http://127.0.0.1:7779")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      await pairNativeGatewayProfile(origin.trim(), code.trim())
      onOpenChange(false)
      setCode("")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pairing failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="w-[min(420px,calc(100vw-24px))] gap-0 rounded-[var(--radius-xl)] border-0 bg-[var(--material-regular)] p-2 shadow-[var(--shadow-overlay)]">
        <form onSubmit={(event) => void submit(event)}>
          <div className="p-5">
            <DialogHeader className="gap-2 text-left">
              <DialogTitle>Add gateway</DialogTitle>
              <DialogDescription>Pair another {PRODUCT_NAME} gateway. It stays inactive until you choose it.</DialogDescription>
            </DialogHeader>
            <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-3)]">
              <PairingFields origin={origin} code={code} onOrigin={setOrigin} onCode={setCode} />
              <ErrorNote message={error} />
            </div>
          </div>
          <DialogFooter className="rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-3 sm:items-center">
            <button type="button" disabled={busy} onClick={() => onOpenChange(false)} className="min-h-10 rounded-[var(--radius-md)] px-4 text-subheadline text-[var(--text-secondary)]">Cancel</button>
            <button type="submit" disabled={busy || !origin.trim() || !code.trim()} className={`${ACCENT_BUTTON} min-w-[132px]`}>
              {busy && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
              {busy ? "Pairing..." : "Pair gateway"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GatewayRow({ profile, isActive, busy, disabled, onUse, onRemove }: {
  profile: NativeGatewayProfile
  isActive: boolean
  busy: boolean
  disabled: boolean
  onUse: () => void
  onRemove: () => void
}) {
  const host = new URL(profile.origin).host
  return (
    <div className="flex min-h-12 items-center gap-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-[var(--space-3)] py-[var(--space-2)]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-medium)] text-[var(--text-primary)]">{profile.name}</div>
        <div className="truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{isActive ? `${host} · last opened` : host}</div>
      </div>
      {busy && <LoaderCircle size={16} className="shrink-0 animate-spin text-[var(--text-tertiary)]" aria-hidden />}
      {!busy && (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={QUIET_BUTTON} disabled={disabled} onClick={onUse}>
            {isActive && <RefreshCw size={13} aria-hidden />}
            {isActive ? "Retry" : "Use"}
          </button>
          <button type="button" aria-label={`Remove ${profile.name}`} className={ICON_BUTTON} disabled={disabled} onClick={onRemove}>
            <Trash2 size={15} aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}

function PairedGateways({ profiles, activeId, busy, onUse, onRemove }: {
  profiles: NativeGatewayProfile[]; activeId?: string; busy?: string; onUse: (id: string) => void; onRemove: (id: string) => void
}) {
  if (profiles.length === 0) return null
  return (
    <div className={`mb-[var(--space-5)] ${PANEL}`}>
      <div className={LABEL}>Paired gateways</div>
      <div className="mt-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
        {profiles.map((profile) => (
          <GatewayRow
            key={profile.id}
            profile={profile}
            isActive={profile.id === activeId}
            busy={busy === profile.id || busy === `remove:${profile.id}`}
            disabled={Boolean(busy)}
            onUse={() => onUse(profile.id)}
            onRemove={() => onRemove(profile.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ScreenHeader({ unreachableName }: { unreachableName?: string }) {
  return (
    <div className="mb-[var(--space-5)] flex items-center gap-[var(--space-3)] px-[var(--space-2)]">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-[var(--accent)]">
        <ShieldCheck size={22} aria-hidden />
      </div>
      <div className="min-w-0">
        <h1 className="text-balance text-[length:var(--text-title3)] font-[var(--weight-semibold)] tracking-[var(--tracking-normal)]">
          {unreachableName ? `Cannot reach ${unreachableName}` : `Connect ${PRODUCT_NAME}`}
        </h1>
        <p className="mt-1 text-pretty text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {unreachableName
            ? "The gateway is not answering. Start it again, choose another paired gateway, or pair a new one."
            : "Add the gateway running on this Mac. HTTP is accepted only for loopback; other gateways require HTTPS."}
        </p>
      </div>
    </div>
  )
}

function PairForm({ titled, busy, error, onSubmit, ...fields }: FieldsProps & {
  titled: boolean; busy?: string; error?: string; onSubmit: (event: FormEvent) => void
}) {
  const pairing = busy === "pair"
  return (
    <form onSubmit={onSubmit} className={`flex flex-col gap-[var(--space-3)] ${PANEL}`}>
      {titled && <div className={LABEL}>Pair another gateway</div>}
      <PairingFields {...fields} />
      <ErrorNote message={error} />
      <button type="submit" disabled={Boolean(busy) || !fields.origin.trim() || !fields.code.trim()} className={`mt-[var(--space-1)] ${ACCENT_BUTTON}`}>
        {pairing && <LoaderCircle size={16} className="animate-spin" aria-hidden />}
        {pairing ? "Pairing..." : "Pair gateway"}
      </button>
    </form>
  )
}

function ConnectingScreen({ name }: { name: string }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-[var(--space-3)] bg-[var(--bg)] p-[var(--space-6)] text-[var(--text-tertiary)]">
      <LoaderCircle size={20} className="animate-spin" aria-hidden />
      <p className="text-[length:var(--text-footnote)]">Connecting to {name}...</p>
    </main>
  )
}

const EMPTY_SNAPSHOT: NativeGatewayProfilesSnapshot = { profiles: [], generation: 0, status: "ready", activeReachable: false }
const readEmpty = () => EMPTY_SNAPSHOT
const neverChanges = () => () => {}

/** Everything this screen reads about the paired gateways, in one place. */
function useGatewayScreen() {
  const manager = nativeGatewayProfiles()
  const read = manager?.snapshot ?? readEmpty
  const { profiles, activeId, status, activeReachable, error } = useSyncExternalStore(manager?.subscribe ?? neverChanges, read, read)
  const active = profiles.find((profile) => profile.id === activeId)
  // The ACTIVE gateway failing is what this screen exists for, and activeReachable
  // is what answers that: failedProfileId names the latest failure of any kind.
  const unreachable = activeReachable ? undefined : active
  return { manager, profiles, activeId, active, unreachable, checking: status === "checking", gatewayError: error }
}

/** Busy key plus error, shared by every action this screen can start. */
function useGatewayAction() {
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key)
    setError(undefined)
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The gateway did not answer")
    } finally {
      setBusy(undefined)
    }
  }
  return { busy, error, run }
}

/**
 * The native window's own gateway surface: shown when the app has no gateway to
 * open yet AND when the remembered one stops answering. The browser's pairing
 * screen belongs to a gateway that replied, so without this a native window that
 * cannot reach its gateway is told to pair with the thing it just failed to talk
 * to, with no way to reach the others it already paired.
 */
export function NativePairingScreen({ onPaired }: { onPaired?: (origin: string) => void }) {
  const { manager, profiles, activeId, active, unreachable, checking, gatewayError } = useGatewayScreen()
  const [origin, setOrigin] = useState("http://127.0.0.1:7779")
  const [code, setCode] = useState("")
  const { busy, error, run } = useGatewayAction()

  function submit(event: FormEvent) {
    event.preventDefault()
    void run("pair", async () => {
      const gateway = await pairAndInstallNativeGateway(origin.trim(), code.trim())
      setCode("")
      onPaired?.(gateway)
    })
  }

  if (checking) return <ConnectingScreen name={active?.name ?? "the gateway"} />

  return (
    <main className="h-dvh overflow-y-auto bg-[var(--bg)] text-[var(--text-primary)] flex items-start sm:items-center justify-center px-[var(--space-4)] py-[max(var(--safe-top),var(--space-8))]">
      <section className="w-full max-w-[560px] rounded-[var(--radius-xl)] bg-[var(--material-regular)] p-[var(--space-6)] shadow-[var(--shadow-card)]">
        <ScreenHeader unreachableName={unreachable?.name} />
        <PairedGateways
          profiles={profiles}
          activeId={activeId}
          busy={busy}
          onUse={(id) => void run(id, () => (id === activeId ? manager!.retry() : manager!.select(id)))}
          onRemove={(id) => void run(`remove:${id}`, () => manager!.remove(id))}
        />
        <PairForm
          titled={profiles.length > 0} origin={origin} code={code} onOrigin={setOrigin} onCode={setCode}
          busy={busy} error={error ?? (unreachable ? gatewayError : undefined)} onSubmit={submit}
        />
      </section>
    </main>
  )
}
