import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * Visual evidence for per-employee Claude profiles: the org chart's profile
 * badge, the employee panel's read-only profile row, and the turn refusal a
 * chat shows for a profile that is not signed in and for one that does not
 * exist. Every element in light and dark, at desktop and phone widths.
 */

const home = process.env.JINN_VERIFY_HOME
const artifacts = process.env.JINN_VERIFY_ARTIFACTS
if (!home || !artifacts) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_ARTIFACTS are required')
const token = (JSON.parse(fs.readFileSync(path.join(home, 'gateway.json'), 'utf8')) as { token: string }).token
const seed = JSON.parse(fs.readFileSync(path.join(home, 'claude-profiles-seed.json'), 'utf8')) as {
  ids: Record<'side-dev' | 'side-missing', string>
  signedOut: string
  missing: string
}

const THEMES = ['light', 'dark'] as const
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const

async function open(browser: Browser, theme: (typeof THEMES)[number], viewport: keyof typeof VIEWPORTS, url: string): Promise<Page> {
  const size = VIEWPORTS[viewport]
  const context = await browser.newContext({
    viewport: size, screen: size, colorScheme: theme,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
  await context.addInitScript((t: string) => {
    localStorage.setItem('jinn-theme', t)
    localStorage.setItem('jinn-onboarded', 'true')
  }, theme)
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  return page
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(artifacts!, `${name}.png`) })

test.beforeAll(async ({ request }) => {
  // One turn per profile state; each is refused before any engine starts.
  for (const id of Object.values(seed.ids)) {
    const res = await request.post(`/api/sessions/${id}/message`, {
      headers: { authorization: `Bearer ${token}` },
      data: { message: 'Pick up the side project backlog.' },
    })
    expect(res.ok()).toBe(true)
  }
  for (const [who, text] of [['side-dev', 'is not signed in'], ['side-missing', 'does not exist']] as const) {
    await expect.poll(async () => {
      const res = await request.get(`/api/sessions/${seed.ids[who]}`, { headers: { authorization: `Bearer ${token}` } })
      return JSON.stringify(await res.json())
    }).toContain(text)
  }
})

for (const theme of THEMES) {
  for (const viewport of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>) {
    test(`org chart profile badge, ${theme}, ${viewport}`, async ({ browser }) => {
      const page = await open(browser, theme, viewport, '/org')
      const badges = page.getByTestId('claude-profile-badge')
      if (viewport === 'desktop') {
        await expect(badges).toHaveCount(2)
        await expect(badges.first()).toHaveText(/\.claude-(friend|gone)/)
      }
      await page.waitForTimeout(500)
      await shot(page, `org-badge-${viewport}-${theme}`)
      await page.context().close()
    })

    test(`employee panel profile row, ${theme}, ${viewport}`, async ({ browser }) => {
      const page = await open(browser, theme, viewport, '/org?employee=side-dev')
      const row = page.getByTestId('claude-profile-row')
      await expect(row).toContainText(seed.signedOut)
      await shot(page, `employee-profile-row-${viewport}-${theme}`)
      const none = await open(browser, theme, viewport, '/org?employee=eng-dev')
      await expect(none.getByText('Eng Dev').first()).toBeVisible()
      await expect(none.getByTestId('claude-profile-row')).toHaveCount(0)
      await shot(none, `employee-default-profile-${viewport}-${theme}`)
      await none.context().close()
      await page.context().close()
    })

    for (const [who, text] of [['side-dev', 'is not signed in'], ['side-missing', 'does not exist']] as const) {
      test(`chat refusal (${who}), ${theme}, ${viewport}`, async ({ browser }) => {
        const page = await open(browser, theme, viewport, `/?session=${seed.ids[who]}`)
        await expect(page.getByText(text).first()).toBeVisible()
        await shot(page, `chat-refusal-${who}-${viewport}-${theme}`)
        await page.context().close()
      })
    }
  }
}
