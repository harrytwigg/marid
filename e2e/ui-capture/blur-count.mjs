// Counts the blurred surfaces on the chat screen, for the blur budget.
//
//   node blur-count.mjs <sandbox-home> <base-url> <out-dir>
//
// For each theme and width it opens the chat, then reports the elements whose computed
// backdrop-filter is not `none`, twice: every one in the DOM, and the ones visible at once
// (inside the viewport, painted, not faded out). It measures with the thread at rest and
// scrolled up, where the jump-to-latest control shows. On desktop it also opens the nav rail's label
// and the Todo mention's glance one at a time: an open overlay is one more surface within the same
// budget. With the Reduced setting on nothing may blur. With Chromium it also measures Reduced from the OS preference, a
// coarse pointer, a CLI view and two panes side by side, where nothing may blur either.
// Exits non-zero when a state is over 3 visible surfaces or a radius is over 32px. Writes <out-dir>/blur-count.json.
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

const results = []
const failures = []

// A second session to put beside the first, found through the API like the capture's own seed does.
async function otherSession() {
  const res = await fetch(`${baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })
  const body = await res.json()
  const list = Array.isArray(body) ? body : body.sessions ?? []
  const other = list.find((s) => s.id && s.id !== fixtures.chatSession)
  if (!other) throw new Error('the sandbox has no second session to open beside the first')
  return other.id
}

// What the page finds in storage before it starts: the theme, Reduced when the setting is on, and
// for the other layouts a two-pane split or a CLI view of the chat.
function storageFor({ theme, reduced, layout }, ids) {
  const entries = { 'jinn-theme': theme, 'jinn-onboarded': 'true' }
  if (reduced === 'setting') entries['jinn-settings'] = JSON.stringify({ transparency: 'reduced' })
  if (layout === 'cli') entries[`jinn-view-mode-${ids.first}`] = 'cli'
  if (layout === 'panes') {
    const group = (id, tab) => ({ type: 'group', id, tabs: [tab], activeTab: tab })
    entries['jinn-chat-split-layout'] = JSON.stringify({
      version: 1,
      root: { type: 'split', id: 's1', direction: 'row', children: [group('g1', ids.first), group('g2', ids.second)], sizes: [0.5, 0.5] },
      auto: false,
      focusedGroupId: 'g1',
      focusHistory: [ids.first, ids.second],
      nextId: 3,
    })
  }
  return entries
}

function newContext({ theme, viewport, pointer }) {
  return browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(pointer === 'coarse' ? { hasTouch: true, isMobile: true } : {}),
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
}

async function open(context, options, ids) {
  await context.addInitScript((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
  }, storageFor(options, ids))
  const page = await context.newPage()
  if (options.reduced === 'os') {
    // The OS preference cannot be set through Playwright, but the DevTools protocol can emulate it.
    const client = await context.newCDPSession(page)
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
  }
  await page.goto(`${baseUrl}/?session=${ids.first}`, { waitUntil: 'networkidle' })
  // A CLI view has no transcript scroller; every layout has a composer.
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

// Nothing may blur under Reduced, with a coarse pointer, in a CLI view or beside other panes;
// otherwise the budget applies.
function noneAllowed({ pointer, reduced, layout }) {
  return Boolean(reduced) || pointer === 'coarse' || layout !== 'chat'
}

function judge(name, rows, options) {
  const visible = rows.filter((row) => row.visible)
  const found = []
  if (noneAllowed(options)) {
    // Reduced and a coarse pointer drop the filter everywhere; a layout only has to show none (the
    // mobile header, display: none from lg, keeps its filter and costs nothing).
    const offenders = options.layout === 'chat' ? rows : visible
    if (offenders.length) found.push(`${name}: ${offenders.length} blurred surface(s) where none is allowed`)
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

// A layout that did not render proves nothing about the budget: the two panes are both there, the
// CLI view has no transcript scroller.
async function layoutRendered(page, layout) {
  return page.evaluate((wanted) => {
    if (wanted === 'panes') return document.querySelectorAll('[data-chat-pane-session]').length >= 2
    if (wanted === 'cli') return !document.querySelector('.chat-messages-scroll')
    return true
  }, layout)
}

// The composer's band overlaps the transcript; its empty parts must hand the pointer to the text
// beneath, or the wheel and a text selection stop working there.
async function bandPassesPointer(page) {
  return page.evaluate(() => {
    const band = document.querySelector('[data-composer-float] [data-chat-composer]')
    if (!band) return true
    const rect = band.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + 60, rect.top + 10)
    return hit !== band && !band.contains(hit)
  })
}

// An overlay open over the chat is a surface of its own, so it has to fit the budget beside the chat's
// own. Each opens by the pointer on desktop (the rail and the hover glance are desktop only, and a
// coarse pointer gets neither) and `shown` says it really did.
const OVERLAYS = [
  {
    name: 'rail-label',
    open: (page) => page.locator('nav[aria-label="Primary"] a[aria-label="Todos"]').hover(),
    shown: (page) => page.evaluate(() => Number(getComputedStyle(document.querySelector('nav[aria-label="Primary"] a[aria-label="Todos"] .rail-reveal')).opacity) > 0.9),
  },
  {
    name: 'todo-glance',
    open: (page) => page.locator('a[href^="/todos/"]').first().hover(),
    shown: (page) => page.locator('.todo-glance').first().waitFor({ timeout: 5_000 }).then(() => true, () => false),
  },
]

function withOverlays({ layout, viewport, pointer }) {
  return layout === 'chat' && viewport.name === 'desktop' && pointer === 'fine'
}

async function measureOverlays(page, name, options) {
  for (const overlay of OVERLAYS) {
    await page.mouse.move(700, 450)
    await overlay.open(page)
    await page.waitForTimeout(500)
    if (!(await overlay.shown(page))) {
      failures.push(`${name}/${overlay.name}: the overlay did not open`)
      continue
    }
    const rows = await page.evaluate(survey)
    record(`${name}/${overlay.name}`, rows)
    failures.push(...judge(`${name}/${overlay.name}`, rows, options))
    await page.mouse.move(700, 450)
    await page.waitForTimeout(300)
  }
}

async function measure(options, ids) {
  const { theme, viewport, pointer, reduced, layout } = options
  const context = await newContext(options)
  const page = await open(context, options, ids)
  const name = [theme, viewport.name, pointer, layout === 'chat' ? '' : layout, reduced ? `${reduced}-reduced` : ''].filter(Boolean).join('-')
  for (const state of ['rest', 'scrolled-up']) {
    if (state === 'scrolled-up') await scrollUp(page)
    const rows = await page.evaluate(survey)
    record(`${name}/${state}`, rows)
    failures.push(...judge(`${name}/${state}`, rows, options))
  }
  if (withOverlays(options)) await measureOverlays(page, name, options)
  if (!(await layoutRendered(page, layout))) failures.push(`${name}: the ${layout} layout did not render`)
  if (!noneAllowed(options) && !(await bandPassesPointer(page))) failures.push(`${name}: the composer band takes the pointer from the transcript under it`)
  await context.close()
}

const DESKTOP = VIEWPORTS.find((v) => v.name === 'desktop')
const NARROW = VIEWPORTS.find((v) => v.name === 'narrow')
const base = { pointer: 'fine', reduced: false, layout: 'chat' }

function variants() {
  const list = THEMES.flatMap((theme) => VIEWPORTS.flatMap((viewport) => [
    { ...base, theme, viewport },
    { ...base, theme, viewport, reduced: 'setting' },
  ]))
  if (!isChromium) return list
  // Chromium only: the OS preference, a coarse pointer, and the layouts that must not blur at all.
  return [
    ...list,
    { ...base, theme: 'dark', viewport: DESKTOP, reduced: 'os' },
    { ...base, theme: 'dark', viewport: NARROW, reduced: 'os' },
    { ...base, theme: 'dark', viewport: NARROW, pointer: 'coarse' },
    { ...base, theme: 'dark', viewport: DESKTOP, layout: 'panes' },
    { ...base, theme: 'dark', viewport: DESKTOP, layout: 'cli' },
  ]
}

try {
  const ids = { first: fixtures.chatSession, second: await otherSession() }
  for (const options of variants()) await measure(options, ids)
} finally {
  await browser.close()
}
fs.writeFileSync(path.join(outDir, 'blur-count.json'), `${JSON.stringify(results, null, 2)}\n`)
if (failures.length) {
  console.error(`blur budget failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
