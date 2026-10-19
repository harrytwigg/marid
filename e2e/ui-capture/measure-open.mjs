// What the first open of a menu downloads, per route (gzip bytes of the scripts it fetches).
//
//   node measure-open.mjs <sandbox-home> <base-url> <out-dir>
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl] = process.argv.slice(2)
const headers = authHeaders(sandboxHome)
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()

const ROUTES = [
  { name: 'chat (model menu)', url: `/?session=${fixtures.chatSession}`, open: (page) => page.getByRole('button', { name: /Opus/ }).first() },
  { name: 'board (Assignee filter)', url: '/todos', open: (page) => page.getByRole('button', { name: 'Assignee' }).first() },
]
for (const route of ROUTES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: headers })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  await page.goto(`${baseUrl}${route.url}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const fetched = []
  page.on('response', async (response) => {
    if (!/\/assets\/.*\.js$/.test(response.url())) return
    const body = await response.body().catch(() => Buffer.alloc(0))
    fetched.push({ name: response.url().split('/').pop(), bytes: gzipSync(body).byteLength })
  })
  // The press with nothing before it, as a first tap on a phone is.
  await route.open(page).evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }))
  })
  await page.getByRole('menu').first().waitFor({ timeout: 8000 })
  await page.waitForTimeout(500)
  const total = fetched.reduce((sum, f) => sum + f.bytes, 0)
  console.log(`${route.name}: ${fetched.length} scripts, ${total} B gzip: ${fetched.map((f) => `${f.name.replace(/-[A-Za-z0-9_-]{8}\.js$/, '')} ${f.bytes}`).join(', ')}`)
  await context.close()
}
await browser.close()
