// Presses the Todos board's Quick capture button while the bar's chunk is still on its way, and checks
// that nothing moves, then lets it arrive. Also checks a chunk that can never arrive.
//
//   node capture-bar-load.mjs <sandbox-home> <base-url> <out-dir>
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) at desktop and phone width and
// exits non-zero when a check fails. Photographs the press (chunk pending) and the arrival, side by side
// as <viewport>-pending.png and <viewport>-arrived.png.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: capture-bar-load.mjs <sandbox-home> <base-url> <out-dir>')
const headers = authHeaders(sandboxHome)
fs.mkdirSync(outDir, { recursive: true })
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const CHUNK = '**/assets/capture-bar-*.js'
const results = []
async function check(name, body) {
  try {
    await body()
    results.push(true)
    console.log(`  ok    ${name}`)
  } catch (err) {
    results.push(false)
    console.log(`  FAIL  ${name}: ${String(err.message).split('\n').slice(0, 4).join(' ; ')}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }

/** Where every column and card is, to the pixel. */
const layout = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-board-column], [data-board-card]')].map((el) => {
      const r = el.getBoundingClientRect()
      return `${el.dataset.boardColumn ?? el.dataset.boardCard}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
    }).join('|'))

async function open(viewport, touch) {
  const context = await browser.newContext({ viewport, hasTouch: touch, extraHTTPHeaders: headers, reducedMotion: 'reduce' })
  await context.addInitScript(() => localStorage.setItem('jinn-onboarded', 'true'))
  return context
}
async function load(page) {
  // Not networkidle: a held chunk keeps a request open.
  await page.goto(`${baseUrl}/todos`, { waitUntil: 'load' })
  await page.getByText('Draft the release checklist').locator('visible=true').first().waitFor({ timeout: 15_000 })
  await page.waitForTimeout(600)
}

for (const [name, viewport, touch] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
  console.log(`${name} (${process.env.JINN_CAPTURE_BROWSER === 'chromium' ? 'Chromium' : 'Firefox'})`)
  const context = await open(viewport, touch)
  const page = await context.newPage()
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  await page.route(CHUNK, async (route) => {
    await held
    await route.continue()
  })
  await load(page)
  const before = await layout(page)
  const button = page.getByTestId('todo-quick-capture')
  await check(`${name}: pressing the button with the chunk still on its way shows an inert scrim and moves nothing`, async () => {
    await (touch ? button.tap() : button.click())
    await page.getByTestId('quick-capture-loading').waitFor({ timeout: 5_000 })
    assert((await page.getByTestId('quick-capture-loading').getAttribute('aria-hidden')) === 'true', 'the scrim is not aria-hidden')
    assert((await page.getByTestId('quick-capture').count()) === 0, 'the bar is already there')
    assert((await layout(page)) === before, 'the board moved while the chunk was pending')
    await page.screenshot({ path: path.join(outDir, `${name}-pending.png`) })
  })
  await check(`${name}: the bar arrives, the scrim goes, and the board is exactly where it was`, async () => {
    release()
    await page.getByTestId('quick-capture').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(500)
    assert((await page.getByTestId('quick-capture-loading').count()) === 0, 'the scrim is still up')
    assert((await layout(page)) === before, 'the board moved when the bar arrived')
    await page.screenshot({ path: path.join(outDir, `${name}-arrived.png`) })
  })
  await context.close()
}

{
  console.log('a chunk that cannot be fetched')
  const context = await open({ width: 1440, height: 900 }, false)
  const page = await context.newPage()
  await page.route(CHUNK, (route) => route.abort())
  await load(page)
  await check('the scrim comes down and the board says so', async () => {
    await page.getByTestId('todo-quick-capture').click()
    await page.getByTestId('board-callout').waitFor({ timeout: 10_000 })
    assert((await page.getByTestId('board-callout').textContent()).includes("Quick capture couldn't load"), 'no message')
    assert((await page.getByTestId('quick-capture-loading').count()) === 0, 'the scrim stayed up')
    assert((await page.getByTestId('quick-capture').count()) === 0, 'a bar appeared')
  })
  await context.close()
}

await browser.close()
const failed = results.filter((ok) => !ok).length
console.log(`${results.length - failed} of ${results.length} checks passed`)
if (failed) process.exit(1)
