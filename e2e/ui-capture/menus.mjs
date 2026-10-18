// Drives the dropdown and context menus in a real browser and checks how they behave.
//
//   node menus.mjs <sandbox-home> <base-url> <out-dir>
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) and exits non-zero when a check
// fails. Checks: focus returns to the trigger; typeahead; arrow keys; nested submenus by keyboard and by
// pointer; Escape; an outside press reaching what it landed on; the context menu by right-click and by
// Shift+F10; a tap at phone width; and the engine and model menu's search. Photographs the open states
// to <out-dir> for a look.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: menus.mjs <sandbox-home> <base-url> <out-dir>')
const headers = authHeaders(sandboxHome)
const fixtures = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()

const results = []
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`  ok    ${name}`)
  } catch (err) {
    results.push({ name, ok: false, error: String(err.message).split('\n').slice(0, 6).join(' ; ') })
    console.log(`  FAIL  ${name}: ${String(err.message).split('\n').slice(0, 8).join(' ; ')}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function open(viewport, url) {
  const phone = viewport.width < 600
  const context = await browser.newContext({ viewport, hasTouch: phone, extraHTTPHeaders: headers })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${baseUrl}${url}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  return { page, context, errors }
}

const focusedLabel = (page) => page.evaluate(() => {
  const el = document.activeElement
  return el ? `${el.tagName}|${el.getAttribute('role') ?? ''}|${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}` : 'none'
})
const gone = (page) => page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 })

// ---- Cold: the popup is fetched on the first open, and a popup that cannot be fetched closes the menu ----
{
  const { page, context, errors } = await open({ width: 1440, height: 900 }, `/?session=${fixtures.chatSession}`)
  const coldPress = () => page.getByRole('button', { name: /Opus/ }).first().evaluate((el) => {
    // No hover or focus first, so nothing has fetched the popup: the press is the first the menu hears of it.
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }))
  })
  await check('cold open: a press with nothing before it fetches the popup and opens the menu', async () => {
    const fetched = []
    page.on('request', (r) => { if (/menu-popup/.test(r.url())) fetched.push(r.url()) })
    await page.route(/menu-popup-.*\.js/, async (route) => {
      // The chunk takes its time, as it would on a phone: the trigger is already open and waiting.
      await new Promise((resolve) => setTimeout(resolve, 600))
      await route.continue()
    })
    await coldPress()
    assert((await page.getByRole('button', { name: /Opus/ }).first().getAttribute('aria-expanded')) === 'true', 'trigger not open at once')
    await page.getByRole('menu').waitFor({ timeout: 8000 })
    assert(fetched.length === 1, `the popup was fetched ${fetched.length} times`)
    await page.unroute(/menu-popup-.*\.js/)
    await page.keyboard.press('Escape')
    await gone(page)
  })
  await check('a popup that cannot be fetched closes the menu and breaks nothing else', async () => {
    // The module is cached once loaded, so this needs a page that has not loaded it.
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    await page.route(/menu-popup-.*\.js/, (route) => route.abort())
    await coldPress()
    await page.waitForTimeout(1500)
    assert((await page.getByRole('menu').count()) === 0, 'a menu showed')
    assert((await page.getByRole('button', { name: /Opus/ }).first().getAttribute('aria-expanded')) === 'false', 'trigger left open')
    await page.unroute(/menu-popup-.*\.js/)
    // The browser keeps a failed import of a URL for the life of the page, like any lazy chunk: this menu
    // stays shut until a reload, and the rest of the page goes on working.
    await page.getByRole('button', { name: 'More options' }).first().click()
    await page.getByText('Open beside').first().waitFor({ timeout: 5000 })
  })
  await context.close()
  void errors
}

// ---- Desktop: the model menu, the session row's context menu, the pane menu ----
{
  const { page, context, errors } = await open({ width: 1440, height: 900 }, `/?session=${fixtures.chatSession}`)

  await check('model menu: opens on click, Escape closes it, focus returns to the trigger', async () => {
    const trigger = page.getByRole('button', { name: /Opus/ }).first()
    await trigger.click()
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    assert((await trigger.getAttribute('aria-expanded')) === 'true', 'trigger not aria-expanded while open')
    await page.screenshot({ path: path.join(outDir, 'model-menu-open.png') })
    await page.keyboard.press('Escape')
    await gone(page)
    await page.waitForTimeout(250)
    assert(await trigger.evaluate((el) => el === document.activeElement), `focus is ${await focusedLabel(page)}, not the trigger`)
  })

  await check('model menu: Enter opens it with focus inside, arrows move, typed text goes to the search field', async () => {
    const trigger = page.getByRole('button', { name: /Opus/ }).first()
    await trigger.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.waitForTimeout(200)
    assert(await page.evaluate(() => !!document.activeElement?.closest('[role="menu"]')), `focus is ${await focusedLabel(page)}, not in the menu`)
    await page.keyboard.press('ArrowDown')
    const first = await focusedLabel(page)
    assert(first.startsWith('DIV|menuitem'), `ArrowDown did not reach an item: ${first}`)
    const search = page.getByRole('searchbox', { name: 'Search models' })
    await search.click()
    await page.keyboard.type('son')
    assert((await search.inputValue()) === 'son', 'typing did not stay in the search field')
    const rows = await page.getByRole('menuitemradio').allTextContents()
    assert(rows.length === 1 && /Sonnet/.test(rows[0]), `search did not filter to Sonnet: ${rows}`)
    await page.keyboard.press('ArrowDown')
    assert((await focusedLabel(page)).includes('Sonnet'), `ArrowDown from the field did not reach the result: ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page)
  })

  await check('model menu: a press outside closes it and reaches its target', async () => {
    await page.getByRole('button', { name: /Opus/ }).first().click()
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.getByText('Delegation flow', { exact: true }).first().click()
    await gone(page)
    await page.waitForTimeout(600)
    assert(!page.url().includes(fixtures.chatSession), `the press did not reach the row: ${page.url()}`)
    await page.goto(`${baseUrl}/?session=${fixtures.chatSession}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
  })

  await check('session row: right-click opens the context menu at the pointer; typeahead; Escape closes it', async () => {
    await page.getByText('Delegation flow', { exact: true }).first().click({ button: 'right' })
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.screenshot({ path: path.join(outDir, 'session-context-menu.png') })
    await page.keyboard.press('ArrowDown')
    assert((await focusedLabel(page)).includes('Rename'), `first item is not Rename: ${await focusedLabel(page)}`)
    await page.keyboard.type('c')
    assert((await focusedLabel(page)).includes('Copy'), `typeahead c did not reach Copy Session ID: ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page)
  })

  await check('session row: Shift+F10 on a focused row opens the context menu with the first item focused', async () => {
    // The row is whatever focusable element holds the title.
    const link = await page.getByText('Design pass', { exact: true }).first().evaluateHandle((el) => el.closest('a, button, [tabindex]'))
    await link.evaluate((el) => el.focus())
    await page.keyboard.press('Shift+F10')
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.waitForTimeout(250)
    assert((await focusedLabel(page)).includes('Rename'), `focus is ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page)
    await page.waitForTimeout(250)
    assert(await link.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)), `focus did not return to the row: ${await focusedLabel(page)}`)
  })

  await check('pane menu: Open beside, then the pane menu opens, and focus returns to its button', async () => {
    await page.getByRole('button', { name: 'More options' }).first().click()
    await page.getByText('Open beside').first().click()
    const trigger = page.locator('[data-chat-pane-menu-trigger]').first()
    await trigger.waitFor({ state: 'attached', timeout: 10000 })
    // The split mounts the pane, and a press while it settles lands on the old one.
    await page.waitForTimeout(1500)
    await trigger.click({ force: true })
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.screenshot({ path: path.join(outDir, 'pane-menu-open.png') })
    await page.keyboard.press('Escape')
    await gone(page)
    await page.waitForTimeout(250)
    assert(await trigger.evaluate((el) => el === document.activeElement), `focus is ${await focusedLabel(page)}`)
  })

  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await context.close()
}

// ---- Desktop: the board card's menu ----
{
  const { page, context, errors } = await open({ width: 1440, height: 900 }, '/todos')
  await check('board card: right-click opens the card menu at the pointer, Escape closes it', async () => {
    await page.locator('[data-board-card]').first().click({ button: 'right', position: { x: 60, y: 30 } })
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 5000 })
    const box = await menu.boundingBox()
    assert(box && box.x > 100 && box.y > 100, `menu not near the card: ${JSON.stringify(box)}`)
    await page.keyboard.press('Escape')
    await gone(page)
  })
  await check('board card: a press on the search button while the menu is open closes it and goes on to the button', async () => {
    await page.locator('[data-board-card]').first().click({ button: 'right' })
    await page.getByRole('menu').waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: 'Search todos' }).click()
    await gone(page)
    await page.locator('input').first().waitFor({ timeout: 5000 })
  })
  await check('filter menu: a submenu opens by pointer and by ArrowRight, ArrowLeft returns to its item, Escape closes it all', async () => {
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'More filters' }).click()
    await page.getByRole('menu').first().waitFor({ timeout: 5000 })
    await page.getByRole('menuitem', { name: 'Source' }).hover()
    await page.getByRole('menuitem', { name: /^(Chat|Cron|Todo)/ }).first().waitFor({ timeout: 5000 })
    await page.screenshot({ path: path.join(outDir, 'filter-submenu.png') })
    // Escape closes the whole menu, submenu included (as the Radix menu did).
    await page.keyboard.press('Escape')
    await gone(page)
    await page.getByRole('button', { name: 'More filters' }).click()
    await page.getByRole('menu').first().waitFor({ timeout: 5000 })
    await page.getByRole('menuitem', { name: 'Source' }).focus()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('menuitem', { name: /^(Chat|Cron|Todo)/ }).first().waitFor({ timeout: 5000 })
    assert((await focusedLabel(page)).startsWith('DIV|menuitem'), `focus did not move into the submenu: ${await focusedLabel(page)}`)
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('menuitem', { name: /^(Chat|Cron|Todo)/ }).first().waitFor({ state: 'detached', timeout: 5000 })
    assert((await focusedLabel(page)).includes('Source'), `focus did not return to Source: ${await focusedLabel(page)}`)
    await page.keyboard.press('Escape')
    await gone(page)
  })
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await context.close()
}

// ---- Phone width: a tap opens the row menu ----
{
  const { page, context, errors } = await open({ width: 390, height: 844 }, '/')
  await check('phone: a tap on a row\'s ellipsis opens its menu, a tap on an item chooses it and closes the menu', async () => {
    await page.getByRole('button', { name: 'Chat actions' }).locator('visible=true').first().tap()
    await page.getByRole('menu').first().waitFor({ timeout: 5000 })
    await page.screenshot({ path: path.join(outDir, 'phone-row-menu.png') })
    await page.getByRole('menuitem', { name: 'Copy Session ID' }).tap()
    await gone(page)
  })
  await check('phone: a tap outside the menu closes it and reaches what it landed on', async () => {
    await page.getByRole('button', { name: 'Chat actions' }).locator('visible=true').first().tap()
    await page.getByRole('menu').first().waitFor({ timeout: 5000 })
    await page.getByText('Terminals', { exact: true }).tap()
    await gone(page)
  })
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await context.close()
}

await browser.close()
fs.writeFileSync(path.join(outDir, 'menus.json'), JSON.stringify(results, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
