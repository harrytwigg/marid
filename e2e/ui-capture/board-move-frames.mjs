// Samples, on every animation frame, which board column holds one card across a
// status move, and fails when any frame finds it in none of them.
//
//   node board-move-frames.mjs <sandbox-home> <base-url> <out-dir> [moves]
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) at phone
// width with touch, the way the reporter saw it. One card is moved back and
// forth between In progress and In review with the card's "Move to…" menu — the
// phone's move, sharing the status lane with the desktop drag — while a
// requestAnimationFrame loop records the columns carrying it. Every frame must
// hold it in exactly one: none is the blink — the optimistic move has left the
// old column and the refetch has not landed in the new one yet — and two means
// the same card drawn twice. Exits non-zero on either, and prints the per-move
// frame counts so a green run shows the probe actually watched.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir, movesArg] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: board-move-frames.mjs <sandbox-home> <base-url> <out-dir> [moves]')
const MOVES = Number(movesArg ?? 10)
if (!Number.isInteger(MOVES) || MOVES < 1) throw new Error(`moves must be a positive integer, got ${movesArg}`)
const headers = authHeaders(sandboxHome)
fs.mkdirSync(outDir, { recursive: true })
const isChromium = process.env.JINN_CAPTURE_BROWSER === 'chromium'
const browser = await (isChromium ? chromium : firefox).launch()
const VIEWPORT = { width: 390, height: 844 }

/* The two columns the walk moves between, and the words the menu shows for
 * them. Nothing here names a fixture: the card is whichever one the column
 * holds first. */
const COLUMNS = {
  executing: { label: 'In progress', to: 'in_review' },
  in_review: { label: 'In review', to: 'executing' },
}

/** The probe's home on the page, the way perf.mjs parks its frame clock. */
/** @typedef {Window & { __boardFrames?: { id: string | null, recording: boolean, samples: string[][] } }} FrameProbeWindow */

const context = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, extraHTTPHeaders: headers, colorScheme: 'light' })
await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
// Installed before the app loads, so the first frame after a repaint is already
// being watched: each frame records the columns whose subtree holds the card.
await context.addInitScript(() => {
  const w = /** @type {FrameProbeWindow} */ (window)
  const probe = { id: null, recording: false, samples: [] }
  w.__boardFrames = probe
  const tick = () => {
    if (probe.recording && probe.id) {
      const id = probe.id
      const holders = []
      for (const column of document.querySelectorAll('[data-board-column]')) {
        if (column.querySelector(`[data-board-card="${id}"]`)) holders.push(column.getAttribute('data-board-column'))
      }
      probe.samples.push(holders)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.goto(`${baseUrl}/todos`, { waitUntil: 'networkidle' })
await page.getByText('Draft the release checklist').locator('visible=true').first().waitFor({ timeout: 15_000 })
await page.waitForTimeout(800)

const strip = (page) => page.getByTestId('todo-board-scroll')
const cardIn = (page, column) => page.getByTestId(`board-column-${column}`).locator('[data-board-card]').first()
const cardId = async (page, column) => cardIn(page, column).getAttribute('data-board-card')

/** Wait for the strip to stop moving. */
async function settled() {
  let last = -1
  for (let i = 0; i < 40; i += 1) {
    const now = await strip(page).evaluate((el) => el.scrollLeft)
    if (now === last) return now
    last = now
    await page.waitForTimeout(120)
  }
  return last
}

const startProbe = (id) => page.evaluate((cardId) => {
  const w = /** @type {FrameProbeWindow} */ (window)
  const probe = w.__boardFrames
  probe.id = cardId
  probe.samples = []
  probe.recording = true
}, id)

const stopProbe = () => page.evaluate(() => {
  const w = /** @type {FrameProbeWindow} */ (window)
  const probe = w.__boardFrames
  probe.recording = false
  return probe.samples
})

const moveCard = async (id, to) => {
  await page.getByTestId(`board-move-${id}`).tap()
  await page.getByRole('menu').waitFor({ timeout: 5_000 })
  await page.getByRole('menuitemradio', { name: to }).tap()
  await page.getByTestId('board-callout').waitFor({ timeout: 5_000 })
}

console.log(`board move frames (${isChromium ? 'Chromium' : 'Firefox'}, ${VIEWPORT.width}x${VIEWPORT.height}, touch, ${MOVES} moves)`)

let column = 'executing'
let id = await cardId(page, column)
await cardIn(page, column).scrollIntoViewIfNeeded()
await settled()

const reports = []
for (let move = 1; move <= MOVES; move += 1) {
  const destination = COLUMNS[column].to
  await startProbe(id)
  await moveCard(id, COLUMNS[column].label === 'In progress' ? 'In review' : 'In progress')
  // Let the status write, its rank follow-up and both column refetches land and settle.
  await page.waitForTimeout(900)
  await cardIn(page, destination).scrollIntoViewIfNeeded()
  await settled()
  const samples = await stopProbe()
  const empty = samples.map((holders, frame) => ({ frame, holders })).filter(({ holders }) => holders.length === 0)
  const doubled = samples.map((holders, frame) => ({ frame, holders })).filter(({ holders }) => holders.length > 1)
  const alsoInSource = samples.filter((holders) => holders.includes(column)).length
  reports.push({ move, from: column, to: destination, frames: samples.length, empty, doubled, alsoInSource })
  console.log(`  move ${move}  ${column} -> ${destination}  frames ${samples.length}  no column ${empty.length}  two columns ${doubled.length}  still in source ${alsoInSource}`)
  if (empty.length > 0) {
    console.log(`         first empty frame ${empty[0].frame} of ${samples.length}; last holders before it: ${JSON.stringify(samples[empty[0].frame - 1] ?? null)}`)
  }
  const landed = await page.getByTestId(`board-column-${destination}`).locator(`[data-board-card="${id}"]`).count()
  if (landed !== 1) throw new Error(`move ${move}: the card is not in ${destination} after the move`)
  column = destination
}

const totalFrames = reports.reduce((sum, r) => sum + r.frames, 0)
const totalEmpty = reports.reduce((sum, r) => sum + r.empty.length, 0)
const totalDoubled = reports.reduce((sum, r) => sum + r.doubled.length, 0)
const totalInSource = reports.reduce((sum, r) => sum + r.alsoInSource, 0)
fs.writeFileSync(path.join(outDir, `board-move-frames-${isChromium ? 'chromium' : 'firefox'}.json`), JSON.stringify(reports, null, 2))
console.log(`${MOVES} moves, ${totalFrames} frames sampled, ${totalEmpty} with the card in no column, ${totalDoubled} with it in two, ${totalInSource} with it still in its old column`)
if (errors.length > 0) console.log(`  page errors: ${errors.join(' ; ')}`)

await context.close()
await browser.close()
if (totalEmpty > 0 || totalDoubled > 0) process.exit(1)
if (errors.length > 0) process.exit(1)
