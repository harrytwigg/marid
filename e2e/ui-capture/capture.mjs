// Photographs every screen in screens.mjs in each theme and viewport.
//
//   node capture.mjs <sandbox-home> <base-url> <out-dir> [screen ...]
//
// Writes <out-dir>/<screen>-<theme>-<viewport>.png. Fails if a screen never
// renders its fixture text, throws a page error, or shows something that looks
// like an id, the sandbox token, a host name or an instance path (including
// form values), since these images go on public PRs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { SCREENS, THEMES, VIEWPORTS } from './screens.mjs'

const [sandboxHome, baseUrl, outDir, ...only] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: capture.mjs <sandbox-home> <base-url> <out-dir> [screen ...]')

const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
const screens = only.length ? SCREENS.filter((s) => only.includes(s.name)) : SCREENS
fs.mkdirSync(outDir, { recursive: true })

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
// Strings that would place the instance: the throwaway home's path (and the
// root it sits in) and this machine's name. Short host names are skipped, as
// they match ordinary words.
const PLACES = [sandboxHome, path.dirname(path.dirname(sandboxHome)), os.hostname()]
  .filter((value) => value && value.length >= 4)

async function leaks(page) {
  // innerText leaves out form values, so read inputs and textareas too.
  const text = await page.evaluate(() => [
    document.body.innerText,
    ...[...document.querySelectorAll('input, textarea')].map((field) => field.value),
  ].join('\n'))
  const found = []
  if (token && text.includes(token)) found.push('the sandbox token')
  const id = text.match(UUID)
  if (id) found.push(`an id-like string (${id[0].slice(0, 8)}…)`)
  if (PLACES.some((place) => text.includes(place))) found.push('a host name or instance path')
  return found
}

// Firefox by default: headless Chromium has hung on this app on some hosts.
// JINN_CAPTURE_BROWSER=chromium switches; keep one browser for a before/after pair.
const browserType = process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox
const browser = await browserType.launch()
const failures = []
const jobs = screens.flatMap((screen) => THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ screen, theme, viewport }))))

async function captureOne({ screen, theme, viewport }) {
  const label = `${screen.name}-${theme}-${viewport.name}`
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    colorScheme: theme,
    // Captures compare states, not transitions.
    reducedMotion: 'reduce',
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
  await context.addInitScript((t) => {
    localStorage.setItem('jinn-theme', t)
    localStorage.setItem('jinn-onboarded', 'true')
  }, theme)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(String(err)))
  try {
    await page.goto(baseUrl + screen.url(fixtures), { waitUntil: 'networkidle' })
    await page.getByText(screen.ready, { exact: false }).locator('visible=true').first().waitFor({ timeout: 15_000 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)
    const leaked = await leaks(page)
    if (leaked.length) throw new Error(`shows ${leaked.join(' and ')}`)
    if (errors.length) throw new Error(`page error: ${errors[0]}`)
    await page.screenshot({ path: path.join(outDir, `${label}.png`) })
    console.log(`captured ${label}`)
  } catch (err) {
    failures.push(`${label}: ${err.message.split('\n')[0]}`)
    await page.screenshot({ path: path.join(outDir, `${label}.failed.png`) }).catch(() => {})
  } finally {
    await context.close()
  }
}

try {
  for (const job of jobs) await captureOne(job)
} finally {
  await browser.close()
}
if (failures.length) {
  console.error(`capture failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
