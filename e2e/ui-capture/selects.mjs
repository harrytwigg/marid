// Drives the selects in a real browser and checks how they behave.
//
//   node selects.mjs <sandbox-home> <base-url> <out-dir>
//
// Runs in the browser JINN_CAPTURE_BROWSER names (Firefox by default) and exits non-zero when a check
// fails. The selects are the ones in the employee editor (Rank, Department, Reports to); the same
// script runs against a build before and after a change to them. Checks: opens on a click and on the
// keyboard, typeahead, a disabled option is skipped and cannot be chosen, Escape closes and focus
// returns to the trigger, an outside press closes without choosing, a choice sticks, a tap at phone
// width. Photographs the closed and open states to <out-dir>, and the settings page's native selects.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, firefox } from '@playwright/test'
import { authHeaders } from './sandbox-auth.mjs'

const [sandboxHome, baseUrl, outDir] = process.argv.slice(2)
if (!sandboxHome || !baseUrl || !outDir) throw new Error('usage: selects.mjs <sandbox-home> <base-url> <out-dir>')
const headers = authHeaders(sandboxHome)
fs.mkdirSync(outDir, { recursive: true })

// Two departments, one scoped (its option is disabled), and a few employees to report to.
const org = path.join(sandboxHome, 'org')
function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}
function employee(department, name, rank, extra = []) {
  write(path.join(org, department, `${name}.yaml`), [
    `name: ${name}`, `displayName: ${name}`, `department: ${department}`, `rank: ${rank}`,
    'engine: claude', 'model: sonnet', ...extra, `persona: Works on ${department}.`,
  ])
}
write(path.join(org, 'engineering', 'department.yaml'), ['name: engineering', 'displayName: Engineering', 'description: Builds the product.'])
write(path.join(org, 'design', 'department.yaml'), ['name: design', 'displayName: Design', 'description: Shapes the product.'])
write(path.join(org, 'side-project', 'department.yaml'), ['name: side-project', 'displayName: Side project', 'description: A side project.', 'scope: scoped'])
employee('engineering', 'eng-lead', 'manager')
employee('engineering', 'eng-dev', 'employee', ['reportsTo: eng-lead'])
employee('side-project', 'side-lead', 'manager')

const browser = await (process.env.JINN_CAPTURE_BROWSER === 'chromium' ? chromium : firefox).launch()
const results = []
async function check(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`  ok    ${name}`)
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}: ${String(err.message).split('\n').slice(0, 8).join(' ; ')}`)
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function open(viewport) {
  const phone = viewport.width < 600
  const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone && process.env.JINN_CAPTURE_BROWSER === 'chromium', extraHTTPHeaders: headers })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${baseUrl}/org?employee=eng-dev`, { waitUntil: 'networkidle' })
  const edit = page.getByRole('button', { name: 'Edit employee' })
  // The org is read when the page loads; a gateway still warming up may not have the new files yet.
  if (!(await edit.waitFor({ timeout: 8000 }).then(() => true, () => false))) await page.reload({ waitUntil: 'networkidle' })
  await edit.click()
  await department(page).waitFor({ timeout: 10000 })
  await page.waitForTimeout(800)
  return { page, context, errors }
}

// By attribute: while a list is open the page behind it is hidden from the accessibility tree.
const department = (page) => page.locator('[role="combobox"][aria-label="Department"]')
const focusedLabel = (page) => page.evaluate(() => {
  const el = document.activeElement
  return el ? `${el.tagName}|${el.getAttribute('role') ?? ''}|${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}` : 'none'
})
const shut = (page) => page.getByRole('listbox').first().waitFor({ state: 'detached', timeout: 5000 })

for (const theme of ['light', 'dark']) {
  const { page, context, errors } = await open({ width: 1440, height: 900 })
  await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, `editor-closed-${theme}.png`) })

  await check(`${theme}: a click opens the list with every option and the current one selected`, async () => {
    await department(page).click()
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    const options = await page.getByRole('option').allTextContents()
    assert(options.length >= 4, `options: ${options}`)
    assert(options.some((o) => /side-project/.test(o)), `no scoped option: ${options}`)
    assert((await page.getByRole('option', { selected: true }).count()) === 1, 'no single selected option')
    await page.waitForTimeout(500) // past the enter animation
    await page.screenshot({ path: path.join(outDir, `department-open-${theme}.png`) })
  })

  await check(`${theme}: a disabled option is not chosen by a click`, async () => {
    const before = await department(page).textContent()
    await page.getByRole('option', { name: /side-project/ }).click({ force: true }).catch(() => {})
    await page.waitForTimeout(300)
    assert((await department(page).textContent()) === before, 'the value changed')
    assert((await page.getByRole('listbox').count()) === 1, 'the list closed on a disabled option')
  })

  await check(`${theme}: Escape closes the list and focus returns to the trigger`, async () => {
    await page.keyboard.press('Escape')
    await shut(page)
    await page.waitForTimeout(300)
    assert(await department(page).evaluate((el) => el === document.activeElement), `focus is ${await focusedLabel(page)}`)
  })

  await check(`${theme}: Enter or ArrowDown opens it from the keyboard with focus in the list; typeahead; Enter chooses`, async () => {
    await department(page).focus()
    await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    await page.waitForTimeout(300)
    assert(await page.evaluate(() => !!document.activeElement?.closest('[role="listbox"]')), `focus is ${await focusedLabel(page)}, not in the list`)
    await page.keyboard.type('d')
    assert((await focusedLabel(page)).includes('design'), `typeahead d did not reach design: ${await focusedLabel(page)}`)
    await page.keyboard.press('Enter')
    await shut(page)
    await page.waitForTimeout(300)
    assert(/design/.test(await department(page).textContent()), `value is ${await department(page).textContent()}`)
    assert(await department(page).evaluate((el) => el === document.activeElement), `focus is ${await focusedLabel(page)}`)
  })

  await check(`${theme}: arrow keys skip the disabled option`, async () => {
    await department(page).focus()
    await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    await page.waitForTimeout(200)
    const seen = []
    for (let i = 0; i < 6; i += 1) {
      seen.push(await focusedLabel(page))
      await page.keyboard.press('ArrowDown')
    }
    assert(!seen.some((s) => /side-project/.test(s)), `focus reached the disabled option: ${seen}`)
    await page.keyboard.press('Escape')
    await shut(page)
  })

  await check(`${theme}: a press outside closes the list without choosing`, async () => {
    const before = await department(page).textContent()
    await department(page).click()
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    await page.mouse.click(1300, 700)
    await shut(page)
    assert((await department(page).textContent()) === before, 'the value changed')
  })

  await check(`${theme}: a click chooses an option and the value shows it`, async () => {
    await department(page).click()
    await page.getByRole('option', { name: 'engineering' }).click()
    await shut(page)
    assert(/engineering/.test(await department(page).textContent()), `value is ${await department(page).textContent()}`)
  })

  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await context.close()
}

{
  const { page, context, errors } = await open({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(outDir, 'editor-closed-phone.png') })
  await check('phone: a tap opens the list, a tap on an option chooses it', async () => {
    await department(page).tap()
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(outDir, 'department-open-phone.png') })
    await page.getByRole('option', { name: 'design' }).tap()
    await shut(page)
    assert(/design/.test(await department(page).textContent()), `value is ${await department(page).textContent()}`)
  })
  await check('phone: the list stays inside the screen', async () => {
    await page.getByRole('combobox').nth(0).tap()
    await page.getByRole('listbox').waitFor({ timeout: 5000 })
    const box = await page.getByRole('listbox').boundingBox()
    assert(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, JSON.stringify(box))
    await page.keyboard.press('Escape')
    await shut(page)
  })
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
  await context.close()
}

{
  // The settings page's native selects: photographed, on a desktop and a phone.
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: headers })
    await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
    const page = await context.newPage()
    await page.goto(`${baseUrl}/settings`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1000)
    const select = page.locator('select').first()
    if (await select.count()) await select.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(outDir, `settings-select-${name}.png`) })
    await context.close()
  }
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
