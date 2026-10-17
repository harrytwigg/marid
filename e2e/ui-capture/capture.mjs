// Photographs every screen in screens.mjs in each theme and viewport.
//
//   node capture.mjs <sandbox-home> <base-url> <out-dir> [screen ...]
//
// Writes <out-dir>/<screen>-<theme>-<viewport>.png. Fails if a screen never
// renders its fixture text, throws a page error, or shows something that looks
// like an id, the sandbox token, a host name or an instance path (including
// form values), since these images go on public PRs.
//
// Each capture also gets an axe accessibility pass. It only reports: the
// summary goes to the console and to <out-dir>/axe.json, and violations never
// fail the run. JINN_CAPTURE_TRANSPARENCY=reduced photographs with
// data-transparency="reduced" on <html>; use a separate out-dir for it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
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

// Firefox by default. Headless Chromium hangs where /dev/dri blocks (see README); capture-ui.sh hides it.
// JINN_CAPTURE_BROWSER=chromium switches; keep one browser for a before/after pair.
const browserType = process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox
const browser = await browserType.launch()
const failures = []
const reduced = process.env.JINN_CAPTURE_TRANSPARENCY === 'reduced'
const axeReport = []
const jobs = screens.flatMap((screen) => THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ screen, theme, viewport }))))

// Report-only: a failure of the audit itself is logged, never thrown.
async function audit(page, label) {
  try {
    const { violations, incomplete } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    const summary = (list) => list.map((rule) => ({ id: rule.id, impact: rule.impact, nodes: rule.nodes.length, targets: rule.nodes.slice(0, 3).map((node) => node.target.join(' ')) }))
    axeReport.push({ label, violations: summary(violations), incomplete: summary(incomplete) })
    const found = violations.map((rule) => `${rule.id} x${rule.nodes.length}`).join(', ')
    console.log(`  axe ${label}: ${violations.length} violation${violations.length === 1 ? '' : 's'}${found ? ` (${found})` : ''}, ${incomplete.length} to review`)
  } catch (err) {
    console.log(`  axe ${label}: audit failed: ${String(err.message).split('\n')[0]}`)
  }
}

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
    // Set after load: the parser replaces <html>, so an init script's attribute is lost.
    if (reduced) await page.evaluate(() => document.documentElement.setAttribute('data-transparency', 'reduced'))
    await page.waitForTimeout(400)
    const leaked = await leaks(page)
    if (leaked.length) throw new Error(`shows ${leaked.join(' and ')}`)
    if (errors.length) throw new Error(`page error: ${errors[0]}`)
    await page.screenshot({ path: path.join(outDir, `${label}.png`) })
    console.log(`captured ${label}`)
    await audit(page, label)
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
if (axeReport.length) fs.writeFileSync(path.join(outDir, 'axe.json'), `${JSON.stringify(axeReport, null, 2)}\n`)
if (failures.length) {
  console.error(`capture failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
