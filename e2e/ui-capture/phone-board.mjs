// Drives the Todos board at phone width in a real browser, with touch, and checks how it behaves.
//
//   node phone-board.mjs <sandbox-home> <base-url> <out-dir>
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) and exits non-zero when a check
// fails. Checks: the board is the default view, one column fills the screen with the next peeking in,
// a swipe settles on a column and the dots follow it, "Move to..." changes a card's status by taps and
// the gateway agrees, a long press does not lift a card (Chromium only: it needs raw touch input),
// and Board | List is switchable by tap and remembered across a reload. Then it records a short video
// of the same walk-through to <out-dir>/phone-board.webm.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: phone-board.mjs <sandbox-home> <base-url> <out-dir>')
const headers = authHeaders(sandboxHome)
fs.mkdirSync(outDir, { recursive: true })
const isChromium = process.env.JINN_CAPTURE_BROWSER === 'chromium'
const browser = await (isChromium ? chromium : firefox).launch()
const VIEWPORT = { width: 390, height: 844 }

const results = []
let pageForShots = null
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`  ok    ${name}`)
  } catch (err) {
    results.push({ name, ok: false })
    await pageForShots?.screenshot({ path: path.join(outDir, `failed-${results.length}.png`) }).catch(() => {})
    console.log(`  FAIL  ${name}: ${String(err.message).split('\n').slice(0, 6).join(' ; ')}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function open(extra = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, extraHTTPHeaders: headers, colorScheme: 'light', ...extra })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${baseUrl}/todos`, { waitUntil: 'networkidle' })
  await page.getByText('Draft the release checklist').locator('visible=true').first().waitFor({ timeout: 15_000 })
  await page.waitForTimeout(800)
  return { page, context, errors }
}

const strip = (page) => page.getByTestId('todo-board-scroll')
const position = (page) => page.getByTestId('board-column-position').getAttribute('aria-label')

/** Wait for the strip to stop moving. */
async function settled(page) {
  let last = -1
  for (let i = 0; i < 40; i += 1) {
    const now = await strip(page).evaluate((el) => el.scrollLeft)
    if (now === last) return now
    last = now
    await page.waitForTimeout(120)
  }
  return last
}

/** A swipe sideways: real touch input where the browser allows it (Chromium), a smooth scroll otherwise. */
async function swipe(page, context, dx) {
  if (isChromium) {
    const cdp = await context.newCDPSession(page)
    const y = 520
    let x = 300
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (let i = 0; i < 12; i += 1) {
      x += dx / 12
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else {
    await strip(page).evaluate((el, by) => el.scrollBy({ left: -by, behavior: 'smooth' }), dx)
  }
  return settled(page)
}

/** How far a column's left edge is from the strip's left edge plus its scroll padding. */
const columnOffset = (page, status) =>
  page.evaluate((s) => {
    const strip = document.querySelector('[data-testid="todo-board-scroll"]')
    const column = document.querySelector(`[data-board-column="${s}"]`)
    return Math.round(column.getBoundingClientRect().left - strip.getBoundingClientRect().left)
  }, status)

async function status(id) {
  const res = await fetch(`${baseUrl}/api/work-items/${id}`, { headers })
  return (await res.json()).workItem.status
}

const moveTrigger = (page, id) => page.getByTestId(`board-move-${id}`)
const cardId = (page, column) => page.getByTestId(`board-column-${column}`).locator('[data-board-card]').first().getAttribute('data-board-card')

async function moveCard(page, id, to) {
  await moveTrigger(page, id).tap()
  await page.getByRole('menu').waitFor({ timeout: 5_000 })
  await page.getByRole('menuitemradio', { name: to }).tap()
  await page.getByTestId('board-callout').waitFor({ timeout: 5_000 })
}

console.log(`phone board checks (${isChromium ? 'Chromium' : 'Firefox'}, ${VIEWPORT.width}x${VIEWPORT.height}, touch)`)

{
  const { page, context, errors } = await open()
  pageForShots = page

  await check('the board is the default view, with a Board | List switch beside Filters', async () => {
    assert(await strip(page).isVisible(), 'the board is not shown')
    assert(await page.getByRole('radio', { name: 'Board' }).isChecked(), 'Board is not the checked view')
    assert(await page.getByTestId('todo-mobile-filters').isVisible(), 'Filters is missing')
  })

  await check('one column fills the screen and the next one peeks in', async () => {
    const first = await page.getByTestId('board-column-backlog').boundingBox()
    const next = await page.locator('[data-board-snap]').nth(1).boundingBox()
    assert(Math.abs(first.width - VIEWPORT.width * 0.84) < 2, `column is ${first.width}px wide, not 84vw`)
    assert(next.x < VIEWPORT.width - 8 && next.x > first.x + first.width, `the next column is not peeking in (x=${next.x})`)
  })

  await check('the dots say which column it is, and follow a swipe', async () => {
    assert((await position(page)).startsWith('Column 1 of '), `starts at ${await position(page)}`)
    await swipe(page, context, -300)
    assert((await position(page)).startsWith('Column 2 of '), `after a swipe: ${await position(page)}`)
  })

  await check('a swipe settles with a column against the left edge (snap)', async () => {
    const offsets = await Promise.all(['backlog', 'blocked', 'executing', 'in_review'].map((s) => columnOffset(page, s).catch(() => null)))
    assert(offsets.some((offset) => offset !== null && Math.abs(offset - 16) <= 2), `no column is snapped: ${offsets.join(', ')}`)
  })

  await check('Move to... changes a card by taps, lands it in the chosen column, and the gateway agrees', async () => {
    await page.getByTestId('board-column-executing').scrollIntoViewIfNeeded()
    await settled(page)
    const id = await cardId(page, 'executing')
    await moveCard(page, id, 'In review')
    assert(await page.getByTestId('board-column-in_review').locator(`[data-board-card="${id}"]`).count() === 1, 'the card is not in In review')
    assert(await page.getByTestId('board-column-executing').locator(`[data-board-card="${id}"]`).count() === 0, 'the card is still in In progress')
    await page.waitForTimeout(600)
    assert((await status(id)) === 'in_review', `the gateway says ${await status(id)}`)
    assert(!/\/todos\/[A-Z]+-\d+/.test(page.url()), `the tap opened the task page (${page.url()})`)
  })

  await check('the current column is marked in the menu', async () => {
    const id = await cardId(page, 'in_review')
    await moveTrigger(page, id).tap()
    await page.getByRole('menu').waitFor()
    const marked = await page.getByRole('menuitemradio', { checked: true }).allTextContents()
    assert(marked.length === 1 && marked[0].includes('In review'), `marked: ${marked.join('|')}`)
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'detached' })
  })

  if (isChromium) {
    await check('a long press does not lift a card', async () => {
      const box = await page.getByTestId('board-column-backlog').locator('[data-board-card]').first().boundingBox()
      await page.getByTestId('board-column-backlog').scrollIntoViewIfNeeded()
      await settled(page)
      const cdp = await context.newCDPSession(page)
      const point = { x: box.x + 60, y: box.y + 40, id: 1 }
      const at = await page.getByTestId('board-column-backlog').locator('[data-board-card]').first().boundingBox()
      point.x = at.x + 60
      point.y = at.y + 40
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
      await page.waitForTimeout(600)
      const lifted = await page.getByTestId('board-drag-slot').count()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
      assert(lifted === 0, 'a held finger lifted the card')
      // A synthesized touch ends in a click, which opens the card; real phones do not click after a long press.
      if (/\/todos\/[A-Z]+-\d+/.test(page.url())) {
        await page.goto(`${baseUrl}/todos`, { waitUntil: 'networkidle' })
        await strip(page).waitFor({ state: 'visible' })
      }
    })
  }

  await check('List is one tap away, and the choice is remembered across a reload', async () => {
    await page.getByRole('radio', { name: 'List' }).locator('..').tap()
    await page.getByTestId('todo-list-scroll').waitFor({ state: 'visible' })
    assert(!(await strip(page).isVisible()), 'the board is still shown')
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByTestId('todo-list-scroll').waitFor({ state: 'visible' })
    assert(await page.getByRole('radio', { name: 'List' }).isChecked(), 'List was not remembered')
    await page.getByRole('radio', { name: 'Board' }).locator('..').tap()
    await strip(page).waitFor({ state: 'visible' })
  })

  assert(errors.length === 0, `page errors: ${errors.join(' ; ')}`)
  await context.close()
}

// The board's surfaces are tints: not a card, a column, a header or the rail blurs what is behind it,
// on a phone or on a desktop (Chromium computes backdrop-filter; Firefox reports none for everything).
for (const [label, viewport, touch] of [['phone', VIEWPORT, true], ['desktop', { width: 1440, height: 900 }, false]]) {
  const context = await browser.newContext({ viewport, hasTouch: touch, extraHTTPHeaders: headers })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  await page.goto(`${baseUrl}/todos`, { waitUntil: 'networkidle' })
  await page.getByText('Draft the release checklist').locator('visible=true').first().waitFor({ timeout: 15_000 })
  await check(`no card, column, header or rail on the ${label} board blurs`, async () => {
    const blurred = await page.evaluate(() =>
      [...document.querySelectorAll('[data-board-card], [data-board-column], [data-board-column-head], [data-board-rail]')]
        .filter((el) => { const f = getComputedStyle(el).backdropFilter; return f && f !== 'none' }).length)
    assert(blurred === 0, `${blurred} blurred surfaces`)
  })
  await context.close()
}

// The walk-through, recorded: the board, a swipe through the columns, a card moved with Move to…, and back.
{
  const { page, context } = await open({ recordVideo: { dir: outDir, size: VIEWPORT } })
  await page.waitForTimeout(900)
  for (const dx of [-300, -300, -300, 900]) {
    await swipe(page, context, dx)
    await page.waitForTimeout(700)
  }
  await page.getByTestId('board-column-backlog').scrollIntoViewIfNeeded()
  await settled(page)
  const id = await cardId(page, 'backlog')
  await page.waitForTimeout(500)
  await moveTrigger(page, id).tap()
  await page.getByRole('menu').waitFor()
  await page.waitForTimeout(1300)
  await page.getByRole('menuitemradio', { name: 'In progress' }).tap()
  await page.getByTestId('board-callout').waitFor()
  await page.waitForTimeout(1600)
  await page.getByTestId('board-column-executing').scrollIntoViewIfNeeded()
  await settled(page)
  await page.waitForTimeout(1600)
  const video = page.video()
  await context.close()
  fs.renameSync(await video.path(), path.join(outDir, 'phone-board.webm'))
  console.log(`  video ${path.join(outDir, 'phone-board.webm')}`)
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length} of ${results.length} checks passed`)
if (failed.length) process.exit(1)
