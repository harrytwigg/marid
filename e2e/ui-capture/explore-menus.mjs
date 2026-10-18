import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
const headers = authHeaders(sandboxHome)
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: headers })
await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
await page.goto(`${baseUrl}/?session=${fixtures.chatSession}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const requests = []
page.on('request', (r) => { if (/menu-popup|overlay-placement|Dialog/.test(r.url())) requests.push(r.url().split('/').pop()) })
// A cold open: the press arrives with no hover or focus before it, so nothing has fetched the popup.
await page.getByRole('button', { name: /Opus/ }).first().evaluate((el) => {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }))
})
await page.waitForTimeout(2500)
console.log('requested after cold press:', requests)
console.log('menus:', await page.getByRole('menu').count())
await browser.close()
