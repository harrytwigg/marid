/**
 * Wire fixtures for the account-limits visual evidence. The sandbox gateway has
 * one Claude account and no remote hosts, so the spec serves these through
 * `page.route` in place of `GET /api/engine-limits`, `GET /api/auto-dispatch/usage`
 * and `GET /api/auto-dispatch/sessions`. Times are relative to the moment a page
 * is opened, so every capture reads the same.
 */

const MIN = 60_000
const HOUR = 60 * MIN

export const FRIEND = 'claude:ab12cd34'
export const STUDIO = 'claude@harry@studio'

export type LimitsState = 'one' | 'two' | 'three' | 'host-asleep' | 'no-reading'

interface Window { name: string; usedPercent: number; windowDurationMins: number; resetsAt: number; resetsAtIso: string }

function windows(now: number, fiveHour: number, weekly: number): Window[] {
  const five = now + 2 * HOUR + 14 * MIN
  const week = now + 3 * 24 * HOUR
  return [
    { name: '5h', usedPercent: fiveHour, windowDurationMins: 300, resetsAt: Math.floor(five / 1000), resetsAtIso: new Date(five).toISOString() },
    { name: '7d', usedPercent: weekly, windowDurationMins: 10080, resetsAt: Math.floor(week / 1000), resetsAtIso: new Date(week).toISOString() },
  ]
}

function snapshot(name: string, now: number, over: Record<string, unknown> = {}) {
  return {
    name, available: true, status: 'live', source: 'statusline', refreshedAt: new Date(now).toISOString(),
    models: [], defaultModel: 'sonnet', accountPlan: 'Max', windows: windows(now, 42, 61), ...over,
  }
}

function account(key: string, label: string, now: number, over: Record<string, unknown> = {}) {
  return { ...snapshot('claude', now), account: key, label, location: { kind: 'local' }, employees: [], ...over }
}

const HOST = { kind: 'remote', host: 'studio' }

function remote(now: number, over: Record<string, unknown>) {
  return account(STUDIO, 'harry@studio', now, { location: HOST, employees: ['studio-dev'], ...over })
}

function friend(now: number, over: Record<string, unknown> = {}) {
  return account(FRIEND, '.claude-friend', now, { accountPlan: 'Pro', windows: windows(now, 27, 38), employees: ['side-dev', 'side-qa'], ...over })
}

/** The extra Claude accounts each state adds beside the default. */
function extras(state: Exclude<LimitsState, 'one'>, now: number): unknown[] {
  switch (state) {
    case 'two':
      return [friend(now)]
    case 'three':
      return [
        friend(now, { windows: windows(now, 100, 96), exhausted: { until: new Date(now + 3 * HOUR + 40 * MIN).toISOString() } }),
        remote(now, { windows: windows(now, 55, 47) }),
      ]
    case 'host-asleep':
      return [remote(now, {
        status: 'snapshot', hostUnreachable: true, refreshedAt: new Date(now - 2 * HOUR).toISOString(),
        windows: windows(now - 2 * HOUR, 35, 52),
      })]
    case 'no-reading':
      return [friend(now, { accountPlan: undefined, status: 'snapshot', noReading: true, windows: [], refreshedAt: '', employees: ['side-dev'] })]
  }
}

export function engineLimits(state: LimitsState, now: number) {
  const claude = snapshot('claude', now)
  const codex = snapshot('codex', now, { accountPlan: 'Plus', windows: windows(now, 18, 33).slice(0, 1) })
  const base = { generatedAt: new Date(now).toISOString(), default: 'claude', engines: { claude, codex } }
  if (state === 'one') return base
  return { ...base, accounts: { claude: [account('claude', 'claude', now), ...extras(state, now)] } }
}

/** Quarter-hourly usage samples for the last 26 hours: the five-hour window climbs and resets every
 *  five hours (the current one ends 2h14m from now), the weekly bucket climbs slowly throughout. */
function samples(now: number, scale: number) {
  const out: Array<{ at: number; windows: Array<{ name: string; usedPercent: number; resetsAt: number }> }> = []
  const week = Math.floor((now + 3 * 24 * HOUR) / 1000)
  const windowEnd = now + 2 * HOUR + 14 * MIN
  const peak = 76 * scale
  for (let at = now - 26 * HOUR; at <= now; at += 15 * MIN) {
    const cycle = Math.floor((windowEnd - at) / (5 * HOUR))
    const end = windowEnd - cycle * 5 * HOUR
    const used = ((at - (end - 5 * HOUR)) / (5 * HOUR)) * peak
    out.push({
      at,
      windows: [
        { name: '5h', usedPercent: Math.round(used), resetsAt: Math.floor(end / 1000) },
        { name: '7d', usedPercent: Math.round((20 + ((at - (now - 26 * HOUR)) / (26 * HOUR)) * 38) * scale), resetsAt: week },
      ],
    })
  }
  return out
}

export const USAGE_ACCOUNTS = [
  { account: 'claude', label: 'claude' },
  { account: FRIEND, label: '.claude-friend' },
]

export function usage(account: string | null, now: number, withAccounts: boolean) {
  const friend = account === FRIEND
  return {
    samples: samples(now, friend ? 0.6 : 1),
    ...(withAccounts ? { account: friend ? FRIEND : 'claude', accounts: USAGE_ACCOUNTS } : {}),
  }
}

export function startedSessions(now: number, withAccounts: boolean) {
  const start = (id: string, minsAgo: number, startedBy: string, account?: string) => ({
    id, engine: 'claude', model: 'sonnet', employee: 'dev', title: `Session ${id}`, source: 'web', status: 'idle',
    createdAt: new Date(now - minsAgo * MIN).toISOString(), startedBy, ...(withAccounts && account ? { account } : {}),
  })
  return {
    sessions: [
      start('a1', 20, 'board-walk-dispatch', 'claude'),
      start('a2', 95, 'dispatch', 'claude'),
      start('a3', 190, 'board-walk-dispatch', 'claude'),
      start('a4', 330, 'cron'),
      start('f1', 40, 'board-walk-dispatch', FRIEND),
      start('f2', 150, 'delegated', FRIEND),
      start('f3', 410, 'board-walk-dispatch', FRIEND),
    ],
  }
}
