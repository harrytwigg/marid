// The Todos tab in the chat layout: beside a chat in a split, in a tab bar with pinned tabs and its pin
// menu, and on a phone (the tab switcher with the Todos entry, and the Todos screen itself). The `board`
// and `board-phone` screens are the board reached by its address, which now opens the same tab. They sit
// in their own file so screens.mjs stays under the size ratchet; it spreads them into SCREENS.
const PLAN_READY = 'Add a step for the changelog'
const BOARD_READY = 'Draft the release checklist'
const NARROW = { width: 390, height: 844 }
const WIDE = { width: 1440, height: 900 }

async function openBeside(page) {
  await page.getByRole('button', { name: 'More options' }).first().click()
  await page.getByText('Open beside').first().click()
  await page.locator('[data-testid="session-picker-row"]').filter({ hasText: 'Delegation flow' }).first().click()
  await page.getByText('Review the release checklist for gaps').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(600)
}

async function openTodosFromRail(page) {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Todos' }).click()
  await page.getByText(BOARD_READY).locator('visible=true').first().waitFor({ timeout: 15_000 })
  await page.mouse.move(900, 700) // off the rail, whose label would cover the list
  await page.waitForTimeout(600)
}

async function pinTab(page, tab) {
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin tab' }).click()
  await page.waitForTimeout(300)
}

/** A chat, the Todo its message names and the Todos tab as three tabs of one pane. */
async function threeTabs(page) {
  await page.getByText('SAN-1', { exact: true }).first().click()
  await page.getByTestId('pane-tab-strip').waitFor({ timeout: 10_000 })
  await openTodosFromRail(page)
}

async function openFromList(page, title) {
  await page.getByText(title, { exact: true }).first().click()
  await page.getByRole('textbox').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(400)
}

const tabBarLink = (page, name) => page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name })

/** Two chats opened on a phone, then the Todos tab opened from the bottom bar. */
async function phoneWithTodos(page) {
  await openFromList(page, 'Chat layout QA')
  await page.getByRole('button', { name: /back|chats/i }).first().click()
  await openFromList(page, 'Delegation flow')
  await page.getByRole('button', { name: /back|chats/i }).first().click()
  await tabBarLink(page, 'Todos').click()
  await page.getByText(BOARD_READY).locator('visible=true').first().waitFor({ timeout: 15_000 })
  await page.waitForTimeout(500)
}

export const TODOS_TAB_SCREENS = [
  {
    // The Todos tab in one pane of a split, a chat in the other.
    name: 'todos-tab-split',
    viewports: ['desktop'],
    title: 'Todos tab in a split, a chat beside it',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await openBeside(page)
      await openTodosFromRail(page)
    },
  },
  {
    // The tab bar with pinned tabs: the chat and the Todos tab pinned (compact, pin glyph), the Todo tab unpinned after them.
    name: 'todos-tab-pinned',
    viewports: ['desktop'],
    title: 'Tab bar with pinned tabs',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await threeTabs(page)
      const strip = page.getByTestId('pane-tab-strip')
      await pinTab(page, strip.getByRole('tab').first())
      await pinTab(page, strip.locator('[data-pane-tab-id="todos:"]'))
      await page.mouse.move(700, 600)
      await page.waitForTimeout(400)
    },
  },
  {
    // The pin/unpin menu on a tab.
    name: 'todos-tab-pin-menu',
    viewports: ['desktop'],
    title: 'Pin menu on a tab',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await threeTabs(page)
      await page.getByTestId('pane-tab-strip').locator('[data-pane-tab-id="todos:"]').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Pin tab' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(300)
    },
  },
  {
    // The phone's tab switcher with the Todos entry beside two chats, a chat in front.
    name: 'todos-tab-phone-switcher',
    viewports: ['narrow'],
    title: 'Phone tab switcher with the Todos entry',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      await phoneWithTodos(page)
      await page.locator('[data-mobile-session-tab]').first().click()
      await page.getByRole('textbox').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The Todos tab on a phone: the board under a header titled Todos, the switcher above it.
    name: 'todos-tab-phone',
    viewports: ['narrow'],
    title: 'Todos tab, phone',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: phoneWithTodos,
  },
  {
    // Pinned tabs lead the phone's switcher. They are pinned from the desktop's tab bar, which the phone has none of.
    name: 'todos-tab-phone-pinned',
    viewports: ['narrow'],
    title: 'Phone tab switcher, pinned tabs first',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await page.setViewportSize(WIDE)
      await page.waitForTimeout(500)
      await threeTabs(page)
      const strip = page.getByTestId('pane-tab-strip')
      await pinTab(page, strip.locator('[data-pane-tab-id="todos:"]'))
      await page.setViewportSize(NARROW)
      await page.waitForTimeout(600)
      await page.getByRole('button', { name: /back|chats/i }).first().click()
      await openFromList(page, 'Delegation flow')
      await page.waitForTimeout(400)
    },
  },
]
