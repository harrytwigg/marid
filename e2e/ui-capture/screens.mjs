// The screens a UI capture photographs. A pull request that changes how a
// screen looks adds it here (or reuses an entry) so before and after are
// always taken the same way. `url` receives the ids seed.mjs wrote; `ready`
// is the text that proves the screen has rendered its data.
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
]

export const THEMES = ['light', 'dark']

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
]
