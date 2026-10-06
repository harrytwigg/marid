import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { FRIEND, engineLimits, startedSessions, usage, type LimitsState } from './fixtures'

/**
 * Visual evidence for per-account Claude limits: the Limits page with one, two
 * and three Claude accounts (one at its limit, a remote account live, one whose
 * host is asleep, one with no reading) and the Auto-Dispatch usage card's
 * account switcher. Every element in light and dark, at desktop and phone
 * widths. The sandbox has a single local account, so the three endpoints these
 * pages read are answered with the wire fixtures in `fixtures.ts`.
 */

const home = process.env.JINN_VERIFY_HOME
const artifacts = process.env.JINN_VERIFY_ARTIFACTS
if (!home || !artifacts) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_ARTIFACTS are required')
const token = (JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8')) as { token: string }).token

const THEMES = ['light', 'dark'] as const
const VIEWPORTS = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } } as const
type Theme = (typeof THEMES)[number]
type Viewport = keyof typeof VIEWPORTS

const LIMIT_STATES: Array<{ state: LimitsState; name: string; text: RegExp[] }> = [
  { state: 'one', name: 'one-account', text: [/Live/] },
  { state: 'two', name: 'two-accounts', text: [/Used by side-dev, side-qa/] },
  { state: 'three', name: 'three-accounts', text: [/At limit/, /Recorded at its limit — resets in/, /on studio/, /Used by studio-dev/] },
  { state: 'host-asleep', name: 'host-asleep', text: [/Host asleep · 2h ago/, /The host is asleep or unreachable; showing the last reading\./] },
  { state: 'no-reading', name: 'no-reading', text: [/No live reading/, /No quota windows observed yet\./] },
]

async function open(browser: Browser, theme: Theme, viewport: Viewport): Promise<Page> {
  const size = VIEWPORTS[viewport]
  const context = await browser.newContext({
    viewport: size, screen: size, colorScheme: theme, serviceWorkers: 'block',
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
  await context.addInitScript((t: string) => {
    localStorage.setItem('jinn-theme', t)
    localStorage.setItem('jinn-onboarded', 'true')
  }, theme)
  return context.newPage()
}

/** The page scrolls inside its own container, so a full-page capture would show only the viewport:
 *  take the first screen, then one more per screen of overflow, named -2, -3 ... */
async function shot(page: Page, name: string) {
  const file = (suffix: string) => path.join(artifacts!, `${name}${suffix}.png`)
  await page.screenshot({ path: file('') })
  const scroller = await page.evaluateHandle(() => {
    const scrollable = [...document.querySelectorAll<HTMLElement>('*')].filter((el) => {
      const overflow = getComputedStyle(el).overflowY
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 4
    })
    return scrollable.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null
  })
  const element = scroller.asElement()
  if (!element) return
  for (let screen = 2; screen <= 4; screen++) {
    const more = await element.evaluate((el) => {
      const before = el.scrollTop
      el.scrollTop = before + el.clientHeight - 60
      return el.scrollTop > before
    })
    if (!more) return
    await page.waitForTimeout(200)
    await page.screenshot({ path: file(`-${screen}`) })
  }
}

async function mockLimits(page: Page, state: LimitsState) {
  await page.route('**/api/engine-limits*', (route) =>
    route.fulfill({ json: engineLimits(state, Date.now()) }))
}

async function mockUsage(page: Page, withAccounts: boolean) {
  const asked: string[] = []
  await page.route('**/api/auto-dispatch/usage*', (route) => {
    const url = new URL(route.request().url())
    asked.push(url.searchParams.get('account') ?? '')
    return route.fulfill({ json: usage(url.searchParams.get('account'), Date.now(), withAccounts) })
  })
  await page.route('**/api/auto-dispatch/sessions*', (route) =>
    route.fulfill({ json: startedSessions(Date.now(), withAccounts) }))
  return asked
}

for (const theme of THEMES) {
  for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
    for (const { state, name, text } of LIMIT_STATES) {
      test(`limits page, ${name}, ${theme}, ${viewport}`, async ({ browser }) => {
        const page = await open(browser, theme, viewport)
        await mockLimits(page, state)
        await page.goto('/limits', { waitUntil: 'networkidle' })
        await expect(page.getByRole('heading', { name: 'Limits', level: 1 })).toBeVisible()
        const groups = page.getByTestId('account-group')
        await expect(groups).toHaveCount(state === 'one' ? 0 : 1)
        for (const pattern of text) await expect(page.getByText(pattern).first()).toBeVisible()
        if (state !== 'one') {
          await expect(groups.getByRole('heading', { level: 3 })).toHaveCount(state === 'three' ? 3 : 2)
        }
        await page.waitForTimeout(600)
        await shot(page, `limits-${name}-${theme}-${viewport}`)
        await page.context().close()
      })
    }

    test(`usage card switcher, ${theme}, ${viewport}`, async ({ browser }) => {
      const page = await open(browser, theme, viewport)
      const asked = await mockUsage(page, true)
      await page.goto('/auto-dispatch', { waitUntil: 'networkidle' })
      const usageCard = page.getByTestId('usage')
      const switcher = usageCard.getByRole('radiogroup', { name: 'Claude account' })
      await expect(switcher).toBeVisible()
      await expect(usageCard.getByRole('heading')).toHaveText('Where the Claude allowance is heading — claude')
      await expect(switcher.getByRole('radio', { name: 'claude', exact: true })).toHaveAttribute('aria-checked', 'true')
      await page.waitForTimeout(600)
      await usageCard.scrollIntoViewIfNeeded()
      await usageCard.screenshot({ path: path.join(artifacts!, `usage-switcher-default-${theme}-${viewport}.png`) })

      await switcher.getByRole('radio', { name: '.claude-friend' }).click()
      await expect(usageCard.getByRole('heading')).toHaveText('Where the Claude allowance is heading — .claude-friend')
      expect(asked).toContain(FRIEND)
      await page.waitForTimeout(600)
      await usageCard.screenshot({ path: path.join(artifacts!, `usage-switcher-friend-${theme}-${viewport}.png`) })
      await shot(page, `auto-dispatch-friend-${theme}-${viewport}`)
      await page.context().close()
    })

    test(`usage card with one account has no switcher, ${theme}, ${viewport}`, async ({ browser }) => {
      const page = await open(browser, theme, viewport)
      await mockUsage(page, false)
      await page.goto('/auto-dispatch', { waitUntil: 'networkidle' })
      const usageCard = page.getByTestId('usage')
      await expect(usageCard.getByRole('heading')).toHaveText('Where the Claude allowance is heading')
      await expect(page.getByRole('radiogroup', { name: 'Claude account' })).toHaveCount(0)
      await page.waitForTimeout(600)
      await usageCard.screenshot({ path: path.join(artifacts!, `usage-one-account-${theme}-${viewport}.png`) })
      await page.context().close()
    })
  }
}

// One pass with nothing mocked: the sandbox's own gateway, seeded with a second local
// account at its limit (scripts/seed-account-limits.mjs), answers /api/engine-limits.
const seed = JSON.parse(fs.readFileSync(path.join(home, 'account-limits-seed.json'), 'utf8')) as { friend: string; account: string }

test('the real gateway lists both local accounts, the named one at its limit', async ({ request }) => {
  const res = await request.get('/api/engine-limits?engine=claude', { headers: { authorization: `Bearer ${token}` } })
  expect(res.ok()).toBe(true)
  const body = await res.json() as { accounts?: { claude?: Array<{ account: string; label: string; employees: string[]; exhausted?: { until?: string } }> } }
  const accounts = body.accounts?.claude ?? []
  expect(accounts.map((account) => account.account)).toEqual(['claude', seed.account])
  expect(accounts[0]!.employees).toContain('eng-dev')
  expect(accounts[1]).toMatchObject({ label: '.claude-friend', employees: ['side-dev'] })
  expect(accounts[1]!.exhausted?.until).toBeTruthy()
})

for (const theme of THEMES) {
  for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
    test(`Limits page on the real gateway, ${theme}, ${viewport}`, async ({ browser }) => {
      const page = await open(browser, theme, viewport)
      await page.goto('/limits', { waitUntil: 'networkidle' })
      await expect(page.getByText('.claude-friend')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('At limit')).toBeVisible()
      await expect(page.getByText('Used by side-dev')).toBeVisible()
      await page.waitForTimeout(600)
      await shot(page, `limits-real-gateway-${theme}-${viewport}`)
      await page.context().close()
    })
  }
}
