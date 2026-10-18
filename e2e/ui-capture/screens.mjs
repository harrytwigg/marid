// The screens a UI capture photographs. A pull request that changes how a
// screen looks adds it here (or reuses an entry) so before and after are
// always taken the same way. `url` receives the ids seed.mjs wrote; `ready`
// is the text that proves the screen has rendered its data.
import { DIALOG_SCREENS } from './screens-dialogs.mjs'
import { ORG_SCREENS } from './screens-org.mjs'

export const SCREENS = [
  {
    name: 'chat',
    title: 'Chat',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
  },
  {
    // The chat over a long thread, scrolled to the middle so text passes under the glass chrome.
    // Run with JINN_CAPTURE_MESSAGES=120 (seed.mjs pads the thread).
    name: 'chat-long',
    longThread: true,
    title: 'Chat, long thread scrolled',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Can you walk me through the next step?',
    prepare: async (page) => {
      await page.evaluate(() => {
        const scroller = document.querySelector('.chat-messages-scroll')
        if (scroller) scroller.scrollTop = scroller.scrollHeight / 2
      })
      await page.waitForTimeout(600)
    },
  },
  {
    name: 'board',
    title: 'Todos board',
    url: () => '/todos',
    ready: 'Draft the release checklist',
  },
  {
    // The board on a phone: columns swiped one at a time, the next peeking in, a Board | List switch
    // beside Filters. (Before the glass board a phone showed the grouped list here.)
    name: 'board-phone',
    viewports: ['narrow'],
    title: 'Todos board, phone',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      // A build before the phone board has no columns here: the screen is then its list.
      const column = page.getByTestId('board-column-executing')
      if (await column.isVisible()) await column.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
    },
  },
  {
    // The strip swiped to its third column: the dots and the count follow it.
    name: 'board-phone-swiped',
    viewports: ['narrow'],
    title: 'Todos board, phone, third column',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      await page.getByTestId('todo-board-scroll').evaluate((strip) => {
        const columns = strip.querySelectorAll('[data-board-snap]')
        if (columns.length < 3) return // before the phone board: nothing to swipe
        strip.scrollLeft = columns[2].getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft - 16
      })
      await page.waitForTimeout(600)
    },
  },
  {
    // The phone's grouped list, one tap away. Tolerates a build with no switch, where the list is all there is.
    name: 'board-phone-list',
    viewports: ['narrow'],
    title: 'Todos list, phone',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      const list = page.getByRole('radio', { name: 'List' })
      if (await list.count()) await list.locator('..').click()
      await page.getByTestId('todo-list-scroll').waitFor({ state: 'visible' })
      await page.waitForTimeout(400)
    },
  },
  {
    // A card's "Move to…" menu, the phone's way to change column.
    name: 'board-phone-move',
    viewports: ['narrow'],
    title: 'Card Move to menu, phone',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      await page.getByRole('button', { name: /^Move .* to…$/ }).first().click()
      await page.getByRole('menu').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The Closed column opened: on the desktop its rail expands in place; on a phone the rail is the
    // last stop of the strip (or, before the glass board, the list's Closed group).
    name: 'board-closed',
    title: 'Todos board, Closed expanded',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      const rail = page.getByTestId('board-closed-rail')
      if (await rail.isVisible()) {
        await rail.scrollIntoViewIfNeeded()
        await rail.click()
        const column = page.getByTestId('board-closed-column')
        await column.waitFor()
        await column.scrollIntoViewIfNeeded()
      } else {
        await page.getByTestId('todo-list-group-closed').locator('button').first().click()
      }
      await page.waitForTimeout(500)
    },
  },
  {
    // A column scrolled under its header: the desktop header sticks, in the panel's own tint.
    // The fixture board is short, so the first column is lengthened with copies of its cards.
    name: 'board-sticky-header',
    viewports: ['desktop'],
    title: 'Board column header stuck',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      await page.getByTestId('todo-board-scroll').evaluate((strip) => {
        const body = strip.querySelector('[data-board-column="backlog"] > div:nth-of-type(2)')
        const first = body.firstElementChild
        for (let i = 0; i < 9; i += 1) body.appendChild(first.cloneNode(true))
        strip.scrollTop = 150
      })
      await page.waitForTimeout(500)
    },
  },
  {
    name: 'todo',
    title: 'Todo page',
    url: (f) => `/todos/${f.todos[0]}`,
    ready: 'Neutral fixture used for interface captures.',
  },
  {
    // The first-run welcome step. `onboarding` leaves the browser un-onboarded and answers /api/onboarding as fresh, so the wizard opens over the chat.
    name: 'onboarding',
    onboarding: true,
    title: 'Onboarding welcome',
    url: () => '/',
    ready: 'Your AI team management portal',
  },
  {
    name: 'settings',
    title: 'Settings',
    url: () => '/settings',
    ready: 'Appearance',
  },
  {
    // The nav rail's label, revealed by the pointer on the Todos icon. The rail is desktop only.
    name: 'rail-tooltip',
    viewports: ['desktop'],
    title: 'Nav rail label, hover',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
    prepare: async (page) => {
      await page.locator('nav[aria-label="Primary"] a[aria-label="Todos"]').hover()
      await page.waitForTimeout(500)
    },
  },
  {
    // The context meter's popover, opened by a click on the ring in the composer.
    name: 'context-popover',
    title: 'Context meter popover',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
    prepare: async (page) => {
      await page.locator('[data-testid="context-meter"]').first().click()
      await page.getByRole('dialog', { name: 'Context usage' }).waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The same label, revealed by focus after a real Tab, which is what a keyboard does.
    name: 'rail-tooltip-keyboard',
    viewports: ['desktop'],
    title: 'Nav rail label, keyboard focus',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
    prepare: async (page) => {
      await page.mouse.move(700, 450)
      await page.keyboard.press('Tab')
      await page.locator('nav[aria-label="Primary"] a[aria-label="Todos"]').focus()
      await page.waitForTimeout(500)
    },
  },
  {
    // A Todo id in the thread, with the glance that reads that Todo opened by the pointer. The
    // glance is off below 640px, so this is desktop only.
    name: 'todo-mention',
    viewports: ['desktop'],
    title: 'Todo mention, hover',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Tracking the checklist in',
    prepare: async (page) => {
      await page.locator('a[href^="/todos/"]').first().hover()
      await page.locator('.todo-glance').first().waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The glance opened from the keyboard: a real Tab, then focus on the mention.
    name: 'todo-mention-keyboard',
    viewports: ['desktop'],
    title: 'Todo mention, keyboard focus',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Tracking the checklist in',
    prepare: async (page) => {
      await page.mouse.move(700, 450)
      await page.keyboard.press('Tab')
      await page.locator('a[href^="/todos/"]').first().focus()
      await page.locator('.todo-glance').first().waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // A session row's actions menu: the context menu by right-click on desktop, the ellipsis button's dropdown on a phone, where the list is the page.
    name: 'session-row-menu',
    title: 'Session row menu',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      if ((page.viewportSize()?.width ?? 0) >= 1024) {
        await page.getByText('Delegation flow', { exact: true }).first().click({ button: 'right' })
      } else {
        await page.getByRole('button', { name: 'Chat actions' }).locator('visible=true').first().click()
      }
      await page.getByRole('menu').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The title bar's menu of a pane in a split chat (Open beside makes the split).
    name: 'pane-menu',
    viewports: ['desktop'],
    title: 'Chat pane menu',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'More options' }).first().click()
      await page.getByText('Open beside').first().click()
      const trigger = page.locator('[data-chat-pane-menu-trigger]').first()
      await trigger.waitFor({ state: 'attached', timeout: 10_000 })
      await trigger.click({ force: true })
      await page.getByRole('menu').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // A board card's menu, opened by a right-click (desktop only: a long press is the card's drag).
    name: 'board-card-menu',
    viewports: ['desktop'],
    title: 'Board card menu',
    url: () => '/todos',
    ready: 'Draft the release checklist',
    prepare: async (page) => {
      await page.locator('[data-board-card]').first().click({ button: 'right' })
      await page.getByRole('menu').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The composer's engine and model menu, with its search and radio list.
    name: 'model-menu',
    title: 'Engine and model menu',
    url: (f) => `/?session=${f.chatSession}`,
    ready: 'Add a step for the changelog',
    prepare: async (page) => {
      await page.getByRole('button', { name: /Opus/ }).first().click()
      await page.getByRole('menu').waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
  ...DIALOG_SCREENS,
  ...ORG_SCREENS,
]

export const THEMES = ['light', 'dark']

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
]
