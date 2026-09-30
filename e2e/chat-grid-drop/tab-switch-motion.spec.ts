import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { openGridPage } from './chat-grid-drop.context'
import { gatewayToken, seededSessionIds } from './chat-grid-drop.helpers'

/**
 * Switching between chats that are already open is instant: no fade, slide or scale of the pane,
 * the header title or the transcript. Opening a chat is not a switch and keeps its entrance, which
 * is what each test checks first — it proves the observer below can see the motion the switch must
 * not have. Every other suite in this directory runs with reduced motion on, so none of them could.
 */

const PHONE = { width: 390, height: 844 }

interface Motion {
  animations: string[]
  minOpacity: number
  maxShiftPx: number
}

/** What an action animates: every CSS animation that starts, and how far the shown chat's
 *  opacity and vertical offset stray from rest over the next 600ms of frames. */
async function motionDuring(page: Page, action: () => Promise<unknown>): Promise<Motion> {
  // An open just before this one may still be finishing its entrance, and frames sampled through its
  // tail would read as this action's motion. Only the app's own entrances are waited for: a spinner
  // elsewhere on the page, or a running chat's jinn-pulse, loops forever and never settles.
  await page.waitForFunction(() => !document.getAnimations().some((animation) => (
    (animation as CSSAnimation).animationName?.startsWith('jinn-')
    && animation.playState === 'running'
    && animation.effect?.getTiming().iterations !== Infinity
  )))
  await page.evaluate(() => {
    const w = window as unknown as { __started?: string[] }
    w.__started = []
    if (!('__watching' in w)) {
      Object.assign(w, { __watching: true })
      document.addEventListener('animationstart', (event) => w.__started!.push(event.animationName), true)
    }
  })
  const frames = page.evaluate(() => new Promise<{ minOpacity: number; maxShiftPx: number }>((resolve) => {
    const shown = '[data-chat-pane-session], [data-mobile-thread-pane], [data-chat-mobile-header] span'
    const start = performance.now()
    let minOpacity = 1
    let maxShiftPx = 0
    const tick = () => {
      document.querySelectorAll(shown).forEach((element) => {
        if (!element.getClientRects().length) return
        let opacity = 1
        for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity)
        minOpacity = Math.min(minOpacity, opacity)
        const transform = getComputedStyle(element).transform
        if (transform !== 'none') maxShiftPx = Math.max(maxShiftPx, Math.abs(new DOMMatrixReadOnly(transform).m42))
      })
      if (performance.now() - start < 600) requestAnimationFrame(tick)
      else resolve({ minOpacity, maxShiftPx })
    }
    tick()
  }))
  await action()
  const { minOpacity, maxShiftPx } = await frames
  const animations = await page.evaluate(() => (window as unknown as { __started: string[] }).__started.filter((name) => name.startsWith('jinn-')))
  return { animations, minOpacity, maxShiftPx }
}

const INSTANT: Motion = { animations: [], minOpacity: 1, maxShiftPx: 0 }

/** A context that starts from this storage. The app persists its own layout from an effect, so the
 *  values are written before its first script, once per tab; a reload then shows what it persisted.
 *  Motion is left on: reduced motion is what every other suite here runs with. */
async function seededContext(browser: Browser, viewport: { width: number; height: number }, storage: Record<string, unknown>, touch = false) {
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: 'light',
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  })
  await context.addInitScript((entries: Record<string, unknown>) => {
    localStorage.setItem('jinn-theme', 'light')
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', 'true')
    if (sessionStorage.getItem('tab-switch-seeded')) return
    sessionStorage.setItem('tab-switch-seeded', '1')
    localStorage.removeItem('jinn-chat-split-layout')
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value))
  }, storage)
  return context
}

async function firstThreeChats(browser: Browser): Promise<string[]> {
  const { context, page } = await openGridPage(browser, { clearWorkingSet: true })
  const ids = await seededSessionIds(page)
  await context.close()
  return ids
}

async function open(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(path, { waitUntil: 'networkidle' })
  return page
}

test('desktop: clicks, ⌘⌥number and ⌘⇧[ ] switch tabs instantly, while opening a chat still animates', async ({ browser }) => {
  const [a, b, c] = await firstThreeChats(browser)
  const workingSet = { version: 1, sessionIds: [a], focusedId: a, focusHistory: [a] }
  const context = await seededContext(browser, { width: 1440, height: 900 }, { 'jinn-chat-working-set': workingSet })
  const page = await open(context, `/?session=${a}`)
  const tab = (id: string) => page.locator(`[data-pane-tab-id="${id}"]`)
  const shown = (id: string) => expect(page.locator(`[data-chat-pane-session="${id}"]`)).toBeVisible()

  // Control: a chat opened from the sidebar plays its entrance, so the observer sees motion.
  const opened = await motionDuring(page, () => page.locator(`[data-chat-session-row="${b}"]`).first().click())
  expect(opened.animations).toContain('jinn-chat-open')
  await tab(b).dblclick()
  await page.locator(`[data-chat-session-row="${c}"]`).first().click()
  await tab(c).dblclick()
  await expect(page.locator('[data-pane-tab-id]')).toHaveCount(3)

  expect(await motionDuring(page, () => tab(a).click())).toEqual(INSTANT)
  await shown(a)
  expect(await motionDuring(page, () => tab(c).click())).toEqual(INSTANT)
  await shown(c)

  expect(await motionDuring(page, () => page.keyboard.press('Meta+Alt+2'))).toEqual(INSTANT)
  await shown(b)
  expect(await motionDuring(page, () => page.keyboard.press('Meta+Alt+1'))).toEqual(INSTANT)
  await shown(a)

  const chord = (key: string) => page.evaluate((chordKey) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: chordKey, metaKey: true, shiftKey: true, bubbles: true }))
  }, key)
  expect(await motionDuring(page, () => chord(']'))).toEqual(INSTANT)
  await shown(b)
  expect(await motionDuring(page, () => chord('['))).toEqual(INSTANT)
  await shown(a)

  // The pane a switch showed never starts the entrance afterwards: a later click that changes
  // nothing about the shown chat must stay still.
  expect(await motionDuring(page, () => tab(a).click())).toEqual(INSTANT)
  await context.close()
})

test('phone: tapping a session tab switches instantly, while opening from the chat list still fades', async ({ browser }) => {
  const [a, b, c] = await firstThreeChats(browser)
  const context = await seededContext(browser, PHONE, {
    'jinn-mobile-session-tabs': { version: 1, sessionIds: [a, b, c] },
    'jinn-chat-working-set': { version: 1, sessionIds: [a], focusedId: a, focusHistory: [a] },
  }, true)
  const page = await open(context, `/?session=${a}`)
  // By role: the edge-back layer keeps a hidden copy of the strip that an attribute selector also matches.
  const tab = (name: string) => page.getByRole('tab', { name, selected: false })
  await expect(page.locator('[data-mobile-session-tab]').first()).toBeVisible()

  for (const [id, name] of [[b, 'Delegation flow'], [c, 'Design pass'], [a, 'Chat layout QA']]) {
    await expect(tab(name)).toBeVisible()
    expect(await motionDuring(page, () => tab(name).tap())).toEqual(INSTANT)
    await expect(page.locator(`[data-mobile-thread-pane="${id}"]`)).toBeVisible()
  }

  // Control, after the taps so a stale mark would show: a chat opened from the list still fades.
  await page.getByRole('button', { name: 'Back to chats' }).tap()
  const opened = await motionDuring(page, () => page.getByText('Release notes', { exact: true }).filter({ visible: true }).first().tap())
  expect(opened.animations).toContain('jinn-mobile-chat-crossfade')
  await context.close()
})
