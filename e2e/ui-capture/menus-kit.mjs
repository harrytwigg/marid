/** The helpers the menu checks share: a recorder of checks and a way to open a page in the sandbox. */
export function createKit({ browser, headers, baseUrl }) {
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

  /**
   * @param {{ width: number, height: number }} viewport
   * @param {string} url
   * @param {{ touch?: boolean, before?: (context: import('@playwright/test').BrowserContext) => unknown }} [options]
   */
  async function open(viewport, url, { touch = viewport.width < 600, before } = {}) {
    const context = await browser.newContext({ viewport, hasTouch: touch, extraHTTPHeaders: headers })
    await context.addInitScript(() => { localStorage.setItem('jinn-onboarded', 'true') })
    await before?.(context)
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    // A held request never lets the network go idle.
    await page.goto(`${baseUrl}${url}`, { waitUntil: before ? 'load' : 'networkidle' })
    await page.waitForTimeout(1200)
    return { page, context, errors }
  }

  const focusedLabel = (page) => page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName}|${el.getAttribute('role') ?? ''}|${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}` : 'none'
  })
  const gone = (page) => page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 })
  return { results, check, assert, open, focusedLabel, gone }
}
