import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { artifactPath, openGridPage } from './chat-grid-drop.context'
import { seededSessionIds } from './chat-grid-drop.helpers'

/**
 * Tabbed chats within a pane, driven the way an operator does it: a sidebar click previews, a
 * double-click keeps, tabs re-order and travel by drag, and an edge drop splits the pane.
 */

const strip = (page: Page) => page.getByTestId('pane-tab-strip')
const tab = (scope: Page | Locator, sessionId: string) => scope.locator(`[data-pane-tab-id="${sessionId}"]`)
/** The strip of the group that holds this chat, wherever that group's shown chat is. */
const stripWith = (page: Page, sessionId: string) => page.getByTestId('pane-tab-strip').filter({ has: page.locator(`[data-pane-tab-id="${sessionId}"]`) })
const pane = (page: Page, sessionId: string) => page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${sessionId}"])`)
const tabIds = (scope: Locator) => scope.locator('[data-pane-tab-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-pane-tab-id')))


/**
 * A page that starts from exactly one chat. The app opens the newest chat on a bare visit and
 * persists its own layout from an effect, so seeding storage on a live page loses that race; the
 * layout is instead cleared, and the working set seeded, before the app's first script. The
 * sessionStorage flag keeps a reload from re-seeding, so persistence is what the reload shows.
 */
async function openWithChat(browser: Browser, options: { video?: boolean; theme?: 'light' | 'dark' }) {
  const { context, page: bare } = await openGridPage(browser, { ...options, clearWorkingSet: true, reducedMotion: true })
  const ids = await seededSessionIds(bare)
  await bare.close()
  await context.addInitScript((first: string) => {
    if (sessionStorage.getItem('pane-tabs-seeded')) return
    sessionStorage.setItem('pane-tabs-seeded', '1')
    localStorage.removeItem('jinn-chat-split-layout')
    localStorage.setItem('jinn-chat-working-set', JSON.stringify({ version: 1, sessionIds: [first], focusedId: first, focusHistory: [first] }))
  }, ids[0])
  const page = await context.newPage()
  // Playwright dismisses dialogs on its own, which would hide a stray confirm(); record them instead.
  const dialogs: string[] = []
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
  await page.goto(`/?session=${ids[0]}`, { waitUntil: 'networkidle' })
  await expect(pane(page, ids[0])).toBeVisible()
  return { context, page, ids, dialogs }
}

async function openFromSidebar(page: Page, sessionId: string): Promise<void> {
  await page.locator(`[data-chat-session-row="${sessionId}"]`).first().click()
  await expect(pane(page, sessionId)).toBeVisible()
}

/** A real pointer drag, slow enough for the drop surface to measure and show its overlay. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }): Promise<void> {
  const box = await from.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 18 })
  await page.waitForTimeout(150)
  await page.mouse.move(to.x + 0.5, to.y + 0.5, { steps: 2 })
  await page.waitForTimeout(150)
  await page.mouse.up()
  await page.waitForTimeout(350)
}

async function pointIn(locator: Locator, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + box!.width * fx, y: box!.y + box!.height * fy }
}

test('sidebar clicks preview, double-click keeps, and the strip re-orders and closes', async ({ browser }) => {
  const { context, page, ids: [a, b, c, d], dialogs } = await openWithChat(browser, { video: true })
  await expect(strip(page)).toHaveCount(0)

  await openFromSidebar(page, b)
  await expect(strip(page)).toHaveCount(1)
  await expect.poll(() => tabIds(strip(page))).toEqual([a, b])
  await expect(tab(page, b)).toHaveAttribute('data-preview', 'true')
  await expect(tab(page, b)).toHaveAttribute('aria-selected', 'true')

  await openFromSidebar(page, c)
  await expect.poll(() => tabIds(strip(page))).toEqual([a, c])

  await tab(page, c).dblclick()
  await expect(tab(page, c)).not.toHaveAttribute('data-preview', 'true')
  await openFromSidebar(page, d)
  await expect.poll(() => tabIds(strip(page))).toEqual([a, c, d])
  await page.screenshot({ path: artifactPath('pane-tabs-preview.png') })

  // Re-order: drag the first tab past the last.
  const last = await tab(page, d).boundingBox()
  await drag(page, tab(page, a), { x: last!.x + last!.width - 4, y: last!.y + last!.height / 2 })
  await expect.poll(() => tabIds(strip(page))).toEqual([c, d, a])

  // Keyboard: Alt+ArrowLeft moves the focused tab back, Delete closes it.
  await tab(page, a).focus()
  await page.keyboard.press('Alt+ArrowLeft')
  await expect.poll(() => tabIds(strip(page))).toEqual([c, a, d])
  await tab(page, a).focus()
  await page.keyboard.press('Delete')
  await expect.poll(() => tabIds(strip(page))).toEqual([c, d])

  // Middle-click closes an inactive tab; × closes the last but one and the strip goes away.
  await tab(page, c).click({ button: 'middle' })
  await expect(strip(page)).toHaveCount(0)
  await expect(pane(page, d)).toBeVisible()
  // Delete and Backspace on a tab close the tab; they must not also reach the delete-session shortcut.
  expect(dialogs).toEqual([])
  await context.close()
})

test("a tab dragged to a pane edge splits, joins another pane by a centre drop, and re-orders there", async ({ browser }) => {
  const { context, page, ids: [a, b, c] } = await openWithChat(browser, { video: true })
  await openFromSidebar(page, b)
  await tab(page, b).dblclick()
  await openFromSidebar(page, c)
  await tab(page, c).dblclick()
  await expect.poll(() => tabIds(strip(page))).toEqual([a, b, c])

  // Edge: drag tab c to the right edge of the pane -> a second pane.
  const only = pane(page, c)
  await drag(page, tab(page, c), await pointIn(only, 0.94, 0.5))
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)
  await expect(page.getByTestId('chat-grid')).toHaveAttribute('data-split-layout', 'arranged')
  await expect.poll(() => tabIds(stripWith(page, a))).toEqual([a, b])
  await expect(pane(page, c)).toBeVisible()
  await page.screenshot({ path: artifactPath('pane-tabs-split.png') })

  // Centre: drag tab b from the left pane onto the middle of the right pane -> joins its group.
  await drag(page, tab(page, b), await pointIn(pane(page, c), 0.5, 0.55))
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)
  await expect.poll(() => tabIds(stripWith(page, c))).toEqual([c, b])

  // Strip: drag tab b ahead of c inside the right pane's strip.
  const head = await tab(stripWith(page, c), c).boundingBox()
  await drag(page, tab(stripWith(page, c), b), { x: head!.x + 4, y: head!.y + head!.height / 2 })
  await expect.poll(() => tabIds(stripWith(page, c))).toEqual([b, c])
  await context.close()
})

test('tabs, their order and the preview mark survive a reload', async ({ browser }) => {
  const { context, page, ids: [a, b, c] } = await openWithChat(browser, {})
  await openFromSidebar(page, b)
  await tab(page, b).dblclick()
  await openFromSidebar(page, c)
  await expect.poll(() => tabIds(strip(page))).toEqual([a, b, c])

  await page.reload({ waitUntil: 'networkidle' })
  await expect(strip(page)).toHaveCount(1)
  await expect.poll(() => tabIds(strip(page))).toEqual([a, b, c])
  await expect(tab(page, c)).toHaveAttribute('data-preview', 'true')
  await expect(tab(page, b)).not.toHaveAttribute('data-preview', 'true')
  await context.close()
})

test('the tab shortcuts act on the strip beside them', async ({ browser }) => {
  const { context, page, ids: [a, b, c], dialogs } = await openWithChat(browser, {})
  await openFromSidebar(page, b)
  await tab(page, b).dblclick()
  await openFromSidebar(page, c)
  await tab(page, c).dblclick()
  await expect.poll(() => tabIds(strip(page))).toEqual([a, b, c])
  await page.locator('body').click({ position: { x: 5, y: 5 } })

  // Cmd+Opt+N picks the Nth tab of the focused group's strip.
  await page.keyboard.press('Meta+Alt+2')
  await expect(tab(page, b)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Meta+Alt+1')
  await expect(tab(page, a)).toHaveAttribute('aria-selected', 'true')

  // Cmd+Shift+] / [ cycle through them, wrapping.
  await page.keyboard.press('Meta+Shift+]')
  await expect(tab(page, b)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Meta+Shift+[')
  await page.keyboard.press('Meta+Shift+[')
  await expect(tab(page, c)).toHaveAttribute('aria-selected', 'true')

  // Cmd+W closes the shown tab and the pane shows a neighbour.
  await page.keyboard.press('Meta+w')
  await expect.poll(() => tabIds(strip(page))).toHaveLength(2)
  await expect(tab(page, c)).toHaveCount(0)

  // A close pressed straight after a switch closes the tab switched to, not the one it left.
  await page.keyboard.press('Meta+Alt+1')
  await expect(tab(page, a)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Meta+Shift+]')
  await page.keyboard.press('Meta+w')
  await expect(tab(page, b)).toHaveCount(0)
  await expect(pane(page, a)).toBeVisible()
  expect(dialogs).toEqual([])
  await context.close()
})

for (const theme of ['light', 'dark'] as const) {
  test(`the active tab stands out from the title bar in the ${theme} theme`, async ({ browser }) => {
    const { context, page, ids: [, b] } = await openWithChat(browser, { theme })
    await openFromSidebar(page, b)
    await tab(page, b).dblclick()
    await expect(tab(page, b)).toHaveAttribute('aria-selected', 'true')

    const fills = await page.evaluate(() => {
      const active = document.querySelector<HTMLElement>('[data-pane-tab-id][aria-selected="true"]')!
      const idle = document.querySelector<HTMLElement>('[data-pane-tab-id][aria-selected="false"]')!
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-pane-title-bar"]')!
      const fill = (node: HTMLElement) => getComputedStyle(node).backgroundColor
      return { active: fill(active), idle: fill(idle), bar: fill(bar) }
    })
    // The shown tab is filled where the resting ones are not, so it reads as selected.
    expect(fills.active).not.toBe(fills.idle)
    expect(fills.active).not.toBe(fills.bar)
    await page.screenshot({ path: artifactPath(`pane-tabs-${theme}.png`) })
    await context.close()
  })
}

test('browsing the sidebar replaces the preview chat instead of growing a strip', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true, reducedMotion: true })
  const [a, b] = await seededSessionIds(page)

  // A bare visit opens the newest chat by itself; that chat is a preview, so choosing another
  // replaces it and the pane keeps its single-chat chrome.
  await openFromSidebar(page, a)
  await openFromSidebar(page, b)
  await expect(strip(page)).toHaveCount(0)
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(1)
  await expect(page.locator('[data-more-menu]:visible').first()).toBeVisible()
  await context.close()
})
