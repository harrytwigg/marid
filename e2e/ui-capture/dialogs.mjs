// Drives the dialogs, the lightbox and the phone sheets in a real browser and checks how they behave.
//
//   node dialogs.mjs <sandbox-home> <base-url> <out-dir>
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) and exits non-zero when a check
// fails. Checks, on the real routes: the new-Todo dialog (focus in, Escape, return of focus, a dirty draft
// asking before it goes, a press on the scrim), the phone's sheet and the picker sheet nested over it, the
// sprint planner opened from a menu and from the filter sheet, the lightbox keyboard (arrows, Escape), the
// page behind staying still, and a dialog chunk that cannot be fetched. Photographs the open states to <out-dir>.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'
import { createKit } from './menus-kit.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: dialogs.mjs <sandbox-home> <base-url> <out-dir>')
fs.mkdirSync(outDir, { recursive: true })
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const { results, check, assert, open, focusedLabel } = createKit({ browser, headers: authHeaders(sandboxHome), baseUrl })

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }
const tid = (page, id) => page.getByTestId(id)
const gone = (page, id) => tid(page, id).waitFor({ state: 'detached', timeout: 5000 })
const insideDialog = (page, id) => tid(page, id).evaluate((el) => el.contains(document.activeElement))
const press = (page, locator, phone) => (phone ? locator.tap() : locator.click())
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) })
const newTodo = (page) => page.locator('[data-testid="todo-new"], [data-testid="todo-new-fab"]').locator('visible=true').first()

async function openNewTodo(page, phone = false) {
  await press(page, newTodo(page), phone)
  await tid(page, 'todo-new-title').waitFor({ timeout: 10000 })
  await page.waitForTimeout(400)
}

async function newTodoChecks() {
  await check('new Todo: focus goes in, Escape closes, focus returns to the button', async () => {
    const { page } = await open(DESKTOP, '/todos')
    await openNewTodo(page)
    const dialog = page.getByRole('dialog', { name: 'New todo' })
    assert(await dialog.evaluate((el) => el.contains(document.activeElement)), `focus ${await focusedLabel(page)}`)
    await shot(page, 'new-todo-open')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
    await page.waitForTimeout(300)
    assert((await focusedLabel(page)).includes('New'), `focus after: ${await focusedLabel(page)}`)
  })
  await check('new Todo: a dirty draft asks before it goes, on Escape and on a press outside', async () => {
    const { page } = await open(DESKTOP, '/todos')
    await openNewTodo(page)
    await tid(page, 'todo-new-title').fill('A draft')
    await page.keyboard.press('Escape')
    await page.getByText('Discard this Todo draft?').waitFor({ timeout: 3000 })
    await page.mouse.click(5, 5)
    await page.waitForTimeout(300)
    assert(await tid(page, 'todo-new-title').count(), 'closed under the question')
    await page.getByRole('button', { name: 'Keep editing' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Discard' }).click()
    await tid(page, 'todo-new-title').waitFor({ state: 'detached', timeout: 5000 })
  })
  await check('new Todo: a press on the scrim closes a clean dialog, and the board behind keeps its place', async () => {
    const { page } = await open(DESKTOP, '/todos')
    await openNewTodo(page)
    assert((await page.evaluate(() => document.documentElement.style.overflow)) === 'hidden', 'page not locked')
    await page.mouse.click(5, 5)
    await tid(page, 'todo-new-title').waitFor({ state: 'detached', timeout: 5000 })
    assert((await page.evaluate(() => document.documentElement.style.overflow)) !== 'hidden', 'lock left behind')
  })
}

async function phoneChecks() {
  await check('phone: the new-Todo sheet sits at the bottom; a picker sheet nests over it and Escape peels them in order', async () => {
    const { page } = await open(PHONE, '/todos')
    await openNewTodo(page, true)
    const sheet = page.getByRole('dialog', { name: 'New todo' })
    const box = await sheet.boundingBox()
    assert(box.y + box.height > PHONE.height - 20, `sheet is not at the bottom: ${JSON.stringify(box)}`)
    await press(page, tid(page, 'todo-new-priority-chip'), true)
    const picker = tid(page, 'todo-new-priority-sheet')
    await picker.waitFor({ timeout: 5000 })
    await page.waitForTimeout(400)
    await shot(page, 'new-todo-picker-sheet')
    assert(await insideDialog(page, 'todo-new-priority-sheet'), `focus ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page, 'todo-new-priority-sheet')
    assert(await tid(page, 'todo-new-title').count(), 'the sheet closed with the picker')
    await page.waitForTimeout(300)
    assert((await focusedLabel(page)).includes('Priority'), `focus after picker: ${await focusedLabel(page)}`)
  })
  await check('phone: the filter sheet opens, Escape closes it, focus returns; Manage sprints opens the planner', async () => {
    const { page } = await open(PHONE, '/todos')
    await press(page, tid(page, 'todo-mobile-filters'), true)
    await tid(page, 'todo-filter-sheet').waitFor({ timeout: 5000 })
    await page.waitForTimeout(400)
    await shot(page, 'filter-sheet-open')
    await page.keyboard.press('Escape')
    await gone(page, 'todo-filter-sheet')
    await page.waitForTimeout(300)
    assert((await focusedLabel(page)).includes('Filters'), `focus after sheet: ${await focusedLabel(page)}`)
    await press(page, tid(page, 'todo-mobile-filters'), true)
    await press(page, tid(page, 'todo-filter-sheet').getByRole('button', { name: /^Sprint/ }), true)
    await press(page, page.getByRole('button', { name: 'Manage sprints…' }), true)
    await tid(page, 'sprints-dialog').waitFor({ timeout: 5000 })
    await page.waitForTimeout(600)
    assert(await tid(page, 'todo-filter-sheet').count() === 0, 'the sheet stayed')
    assert(await insideDialog(page, 'sprints-dialog'), `focus ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page, 'sprints-dialog')
  })
}

async function sprintAndLightboxChecks() {
  await check('sprint planner from the filter menu: holds focus, Escape closes it', async () => {
    const { page } = await open(DESKTOP, '/todos')
    await tid(page, 'filter-chip-sprint').click()
    await tid(page, 'filter-sprint-manage').click()
    await tid(page, 'sprints-dialog').waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    assert(await insideDialog(page, 'sprints-dialog'), `focus ${await focusedLabel(page)}`)
    await shot(page, 'sprints-open')
    await page.keyboard.press('Escape')
    await gone(page, 'sprints-dialog')
  })
  await check('lightbox: arrows move between images, Escape closes it and focus returns to the tile', async () => {
    const { page } = await open(DESKTOP, `/todos/${fixtures.todos[0]}`)
    const tile = page.locator('[data-testid^="attachment-tile-"]').locator('visible=true').first()
    await tile.click()
    const img = tid(page, 'attachment-lightbox-image')
    await img.waitFor({ timeout: 5000 })
    const first = await img.getAttribute('src')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction((s) => document.querySelector('[data-testid="attachment-lightbox-image"]')?.getAttribute('src') !== s, first)
    await shot(page, 'lightbox-open')
    await page.keyboard.press('Escape')
    await gone(page, 'attachment-lightbox')
    await page.waitForTimeout(300)
    assert((await page.evaluate(() => document.activeElement?.dataset?.testid ?? '')).startsWith('attachment-tile-'), `focus ${await focusedLabel(page)}`)
  })
}

async function failureChecks() {
  await check('a dialog chunk that cannot be fetched: the board says so and stays usable', async () => {
    const { page, errors } = await open(DESKTOP, '/todos', { before: (context) => context.route(/new-todo-dialog-.*\.js/, (route) => route.abort()) })
    await newTodo(page).click()
    await page.getByText(/couldn't load/i).first().waitFor({ timeout: 5000 })
    assert((await page.locator('[data-testid="todo-new-loading"]').count()) === 0, 'scrim left behind')
    assert(await newTodo(page).isEnabled(), 'the board is not usable')
    assert(errors.length === 0, `page errors: ${errors}`)
  })
}

try {
  await newTodoChecks()
  await phoneChecks()
  await sprintAndLightboxChecks()
  await failureChecks()
} finally {
  await browser.close()
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
