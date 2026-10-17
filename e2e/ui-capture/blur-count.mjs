// Counts the blurred surfaces on the chat screen, for the blur budget.
//
//   node blur-count.mjs <sandbox-home> <base-url> <out-dir>
//
// For each theme and width it opens the chat, then reports the elements whose computed
// backdrop-filter is not `none`, twice: every one in the DOM, and the ones visible at once
// (inside the viewport, painted, not faded out). It measures with the thread at rest and
// scrolled up, where the jump-to-latest control shows, and with the Reduced setting on,
// where nothing may blur. With Chromium it also measures a coarse pointer, which keeps the
// opaque fallback. Exits non-zero when a state is over 3 visible surfaces or a radius is
// over 32px. Writes <out-dir>/blur-count.json.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { THEMES, VIEWPORTS } from './screens.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: blur-count.mjs <sandbox-home> <base-url> <out-dir>')

const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })

const MAX_VISIBLE = 3
const MAX_RADIUS = 32
const isChromium = process.env.JINN_CAPTURE_BROWSER === 'chromium'
const browser = await (isChromium ? chromium : firefox).launch()

// Runs in the page. The label names an element by tag, glass class and data attributes only, so it
// can go on a public pull request.
function survey() {
  const label = (el) => {
    const attrs = [...el.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label')
    const rect = el.getBoundingClientRect()
    const where = `${Math.round(rect.width)}x${Math.round(rect.height)} at ${Math.round(rect.left)},${Math.round(rect.top)}`
    const glass = [...el.classList].filter((c) => c.startsWith('glass-') || c === 'composer-card')
    return `${el.tagName.toLowerCase()}${glass.map((c) => `.${c}`).join('')}${attrs.map((a) => `[${a.name}${a.value ? `="${a.value}"` : ''}]`).join('')} ${where}`
  }
  const painted = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.01) return false
    }
    return true
  }
  const filterOf = (style) => (style.backdropFilter && style.backdropFilter !== 'none' ? style.backdropFilter : style.webkitBackdropFilter)
  const inViewport = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
  const row = (el, filter) => {
    const radius = Number((/blur\(([\d.]+)px\)/.exec(filter) ?? [])[1] ?? 0)
    return { el: label(el), filter, radius, visible: inViewport(el.getBoundingClientRect()) && painted(el) }
  }
  return [...document.querySelectorAll('*')]
    .map((el) => [el, filterOf(getComputedStyle(el))])
    .filter(([, filter]) => filter && filter !== 'none')
    .map(([el, filter]) => row(el, filter))
}

async function open(browserContext) {
  const page = await browserContext.newPage()
  await page.goto(baseUrl + `/?session=${fixtures.chatSession}`, { waitUntil: 'networkidle' })
  await page.locator('.chat-messages-scroll').first().waitFor({ timeout: 15_000 })
  await page.locator('[data-chat-composer]').first().waitFor({ timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  return page
}

async function scrollUp(page) {
  await page.evaluate(() => {
    const scroller = document.querySelector('.chat-messages-scroll')
    if (scroller) scroller.scrollTop = 0
  })
  await page.waitForTimeout(500)
}

const results = []
const failures = []

function newContext({ theme, viewport, pointer }) {
  return browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(pointer === 'coarse' ? { hasTouch: true, isMobile: true } : {}),
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
}

// What a state is allowed: nothing under Reduced or a coarse pointer, otherwise the budget.
function judge(name, rows, { pointer, reduced }) {
  const visible = rows.filter((row) => row.visible)
  const found = []
  if (reduced || pointer === 'coarse') {
    if (rows.length) found.push(`${name}: ${rows.length} blurred surface(s) where none is allowed`)
  } else if (visible.length > MAX_VISIBLE) {
    found.push(`${name}: ${visible.length} visible blurred surfaces (budget ${MAX_VISIBLE})`)
  }
  for (const row of rows.filter((r) => r.radius > MAX_RADIUS)) found.push(`${name}: blur radius ${row.radius}px on ${row.el}`)
  return found
}

function record(name, rows) {
  const visible = rows.filter((row) => row.visible)
  results.push({ state: name, inDom: rows.length, visible: visible.length, maxRadius: Math.max(0, ...rows.map((r) => r.radius)), rows })
  console.log(`${name}: ${rows.length} in DOM, ${visible.length} visible`)
  for (const row of rows) console.log(`    ${row.visible ? 'visible' : 'hidden '} ${row.filter}  ${row.el}`)
}

async function measure(options) {
  const { theme, viewport, pointer, reduced } = options
  const context = await newContext(options)
  await context.addInitScript(([t, isReduced]) => {
    localStorage.setItem('jinn-theme', t)
    localStorage.setItem('jinn-onboarded', 'true')
    if (isReduced) localStorage.setItem('jinn-settings', JSON.stringify({ transparency: 'reduced' }))
  }, [theme, reduced])
  const page = await open(context)
  const name = `${theme}-${viewport.name}-${pointer}${reduced ? '-reduced' : ''}`
  for (const state of ['rest', 'scrolled-up']) {
    if (state === 'scrolled-up') await scrollUp(page)
    const rows = await page.evaluate(survey)
    record(`${name}/${state}`, rows)
    failures.push(...judge(`${name}/${state}`, rows, options))
  }
  await context.close()
}

try {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      await measure({ theme, viewport, pointer: 'fine', reduced: false })
      await measure({ theme, viewport, pointer: 'fine', reduced: true })
    }
  }
  if (isChromium) for (const viewport of VIEWPORTS.filter((v) => v.name === 'narrow')) await measure({ theme: 'dark', viewport, pointer: 'coarse', reduced: false })
} finally {
  await browser.close()
}
fs.writeFileSync(path.join(outDir, 'blur-count.json'), `${JSON.stringify(results, null, 2)}\n`)
if (failures.length) {
  console.error(`blur budget failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
