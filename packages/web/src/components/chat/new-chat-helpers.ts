export interface NewSessionSelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
  /** Declared Claude account the new chat starts on; kept beside the bare engine, never inside it. */
  profile?: string
}

/** The one place the primary profile is composed into the engine string the gateway takes: `claude:<name>`. */
export function composeSessionEngine(engine?: string | null, profile?: string | null): string | undefined {
  if (!engine) return undefined
  return engine === 'claude' && profile ? `claude:${profile}` : engine
}

export interface NewSessionEmployeeDefaults {
  name: string
  engine?: string | null
  model?: string | null
  effortLevel?: string | null
}

function cleanSelector(value: NewSessionSelectorValue | undefined): NewSessionSelectorValue {
  const clean = (v: string | null | undefined) => {
    const t = typeof v === 'string' ? v.trim() : ''
    return t ? t : undefined
  }
  const engine = clean(value?.engine)
  return {
    engine,
    model: clean(value?.model),
    effortLevel: clean(value?.effortLevel),
    // A profile only means anything on claude; moving off it clears the choice.
    profile: engine === 'claude' ? clean(value?.profile) : undefined,
  }
}

/**
 * Resolve the selector shown/sent for a new chat.
 *
 * Employee config is the default only while the operator has not manually picked
 * a model/effort in the current composer. Once they do, that explicit choice
 * wins even if they later choose a non-COO employee.
 */
export function resolveNewSessionSelector(opts: {
  selectedEmployee?: NewSessionEmployeeDefaults | null
  storedSelector?: NewSessionSelectorValue
  currentSelector?: NewSessionSelectorValue
  manuallyChanged: boolean
}): NewSessionSelectorValue {
  if (opts.manuallyChanged) return cleanSelector(opts.currentSelector)
  if (opts.selectedEmployee) {
    return cleanSelector({
      engine: opts.selectedEmployee.engine ?? undefined,
      model: opts.selectedEmployee.model ?? undefined,
      effortLevel: opts.selectedEmployee.effortLevel ?? undefined,
    })
  }
  return cleanSelector(opts.storedSelector)
}

export function shouldPersistNewSessionSelector(opts: {
  selectedEmployee?: string | null
  manuallyChanged: boolean
}): boolean {
  return !opts.selectedEmployee || opts.manuallyChanged
}

/**
 * Build the params object for creating a new session via POST /api/sessions.
 * When an employee is selected, include the employee field.
 * When COO is selected (null), omit the employee field entirely.
 */
export function buildNewSessionParams(opts: {
  message: string
  selectedEmployee: string | null
  attachmentIds?: string[]
  /** Engine for the new session (new-chat only). Omit to use the employee/global default. */
  engine?: string | null
  /** Declared Claude account to start on; composed into the engine string here, nowhere else. */
  profile?: string | null
  /** Model id for the new session. */
  model?: string | null
  /** Effort level for the new session (only sent for effort-capable models). */
  effortLevel?: string | null
  /** True when the first message contains speech-to-text-derived content. */
  speech?: boolean
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    source: 'web',
    prompt: opts.message,
  }

  if (opts.speech) params.speech = true

  if (opts.selectedEmployee) {
    params.employee = opts.selectedEmployee
  }

  if (opts.attachmentIds && opts.attachmentIds.length > 0) {
    params.attachments = opts.attachmentIds
  }

  const engine = composeSessionEngine(opts.engine, opts.profile)
  if (engine) params.engine = engine
  if (opts.model) params.model = opts.model
  if (opts.effortLevel) params.effortLevel = opts.effortLevel

  return params
}
