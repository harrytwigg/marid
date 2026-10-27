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

/**
 * The profile that may actually be sent for a remembered/chosen name: only one
 * confirmed declared (the chains read has loaded and lists it) and only for a
 * local employee. Derived at render and send time — the stored choice itself is
 * never rewritten by this, so browsing a remote employee does not erase it.
 */
export function effectivePrimaryProfile(opts: {
  profile?: string | null
  declared?: readonly string[] | null
  employeeRemote?: boolean
}): string | undefined {
  if (!opts.profile || opts.employeeRemote || !opts.declared) return undefined
  return opts.declared.includes(opts.profile) ? opts.profile : undefined
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

/** Create params for a fresh continuation chat: it inherits the previous
 *  session's primary profile, except for a remote employee, whom the gateway
 *  would refuse it for. */
export function buildFreshChatParams(opts: {
  message: string
  previous: { employee?: string; engine?: string; model?: string; effortLevel?: string; profile?: string }
  employeeRemote?: boolean
}): Record<string, unknown> {
  return buildNewSessionParams({
    message: opts.message,
    selectedEmployee: opts.previous.employee ?? null,
    engine: opts.previous.engine,
    profile: opts.employeeRemote ? undefined : opts.previous.profile,
    model: opts.previous.model,
    effortLevel: opts.previous.effortLevel,
  })
}
