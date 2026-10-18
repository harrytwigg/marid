// The cold-open, failed-fetch and idle warm-up checks of menus.mjs.
const POPUP = /menu-popup-.*\.js/
const DESKTOP = { width: 1440, height: 900 }

/** A press with no hover or focus before it: the first the trigger hears of the menu. */
const coldPress = (trigger) => trigger.evaluate((el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' })))

// The popup is held back until released, so the press comes while it is still on its way, as a first tap on a phone does.
async function whileArriving({ headers, fixtures }, { check, assert, open, gone }) {
  let release
  const held = new Promise((resolve) => { release = resolve })
  const { page, context } = await open(DESKTOP, `/?session=${fixtures.chatSession}`, {
    before: (ctx) => ctx.route(POPUP, async (route) => { await held; await route.continue() }),
  })
  await check('cold open: a press while the popup is still arriving opens the trigger at once and the menu when it lands', async () => {
    const trigger = page.getByRole('button', { name: /Opus/ }).first()
    await coldPress(trigger)
    assert((await trigger.getAttribute('aria-expanded')) === 'true', 'trigger not open at once')
    await page.waitForTimeout(400)
    assert((await page.getByRole('menu').count()) === 0, 'the menu showed before its popup arrived')
    release()
    await page.getByRole('menu').waitFor({ timeout: 8000 })
    await page.keyboard.press('Escape')
    await gone(page)
  })
  await context.close()
  void headers
}

async function neverArrives({ fixtures }, { check, assert, open }) {
  const { page, context } = await open(DESKTOP, `/?session=${fixtures.chatSession}`, {
    before: (ctx) => ctx.route(POPUP, (route) => route.abort()),
  })
  await check('a popup that cannot be fetched closes the menu and breaks nothing else', async () => {
    const trigger = page.getByRole('button', { name: /Opus/ }).first()
    await coldPress(trigger)
    await page.waitForTimeout(1500)
    assert((await page.getByRole('menu').count()) === 0, 'a menu showed')
    assert((await trigger.getAttribute('aria-expanded')) === 'false', 'trigger left open')
    // The browser keeps a failed import of a URL for the life of the page, like any lazy chunk: this menu
    // stays shut until a reload, and the rest of the page goes on working.
    await page.getByRole('button', { name: 'More options' }).first().click()
    await page.getByText('Open beside').first().waitFor({ timeout: 5000 })
  })
  await context.close()
}

// Nothing of the popup is fetched before the page has loaded; once it has, and the page is idle, it is warmed with no press.
async function warmUp({ browser, headers, baseUrl }, { check, assert }) {
  const context = await browser.newContext({ viewport: DESKTOP, extraHTTPHeaders: headers })
  await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
  const page = await context.newPage()
  const fetches = []
  let loadedAt = null
  page.on('request', (r) => { if (POPUP.test(r.url())) fetches.push(Date.now()) })
  page.on('load', () => { loadedAt = Date.now() })
  await check('warm-up: the popup is not fetched before the page has loaded, and is fetched on idle after it, with no press', async () => {
    await page.goto(`${baseUrl}/todos`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelector('[data-board-card]'), null, { timeout: 15000 })
    assert(loadedAt !== null, 'no load event')
    assert(fetches.every((at) => at >= loadedAt), 'the popup was fetched before the page had loaded')
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /menu-popup-.*\.js/.test(e.name)), null, { timeout: 9000 })
    assert(fetches.length === 1, `the popup was fetched ${fetches.length} times`)
  })
  await context.close()
}

export async function runCold(world, kit) {
  await whileArriving(world, kit)
  await neverArrives(world, kit)
  await warmUp(world, kit)
}
