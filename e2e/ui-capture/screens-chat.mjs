// The chat screens the glass pass photographs beyond the plain `chat` entry: a thread with delegation cards,
// the code block's hover, two panes side by side, the phone's chat list and its session tabs, and the
// header's menu. They sit in their own file so screens.mjs stays under the size ratchet; it spreads
// them into SCREENS.
const PLAN_READY = 'Add a step for the changelog'
const CARDS_READY = 'Review the release checklist for gaps'

async function openBeside(page) {
  await page.getByRole('button', { name: 'More options' }).first().click()
  await page.getByText('Open beside').first().click()
  await page.locator('[data-testid="session-picker-row"]').filter({ hasText: 'Delegation flow' }).first().click()
  await page.getByText(CARDS_READY).first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(800)
}

async function openFromList(page, title) {
  await page.getByText(title, { exact: true }).first().click()
  await page.getByRole('textbox').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)
}

export const CHAT_SCREENS = [
  {
    // Delegation cards in each state (replied, working) in a thread.
    name: 'chat-delegation',
    title: 'Chat with delegation cards',
    url: (f) => `/?session=${f.delegationSession}`,
    ready: CARDS_READY,
  },
  {
    // The code block with the pointer over it, so the copy control shows.
    name: 'chat-code-block',
    viewports: ['desktop'],
    title: 'Chat code block, hovered',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await page.locator('pre.code-block').first().hover()
      await page.waitForTimeout(400)
    },
  },
  {
    // Two panes: the first chat with its title bar and the delegation chat beside it.
    name: 'chat-multi-pane',
    viewports: ['desktop'],
    title: 'Chat, two panes',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: openBeside,
  },
  {
    // The list a phone shows at the chat route (the panel from lg up).
    name: 'chat-list',
    title: 'Chat list',
    url: () => '/',
    ready: 'Delegation flow',
  },
  {
    // Two chats open on a phone: the session tabs under the nav bar.
    name: 'chat-mobile-tabs',
    viewports: ['narrow'],
    title: 'Chat with session tabs, phone',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      await openFromList(page, 'Chat layout QA')
      await page.getByRole('button', { name: /back|chats/i }).first().click()
      await openFromList(page, 'Delegation flow')
    },
  },
  {
    // A new chat's employee picker. Needs the seeded org, or there is only the COO to pick.
    name: 'chat-new',
    title: 'New chat, employee picker',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'New chat' }).first().click()
      await page.getByText('Who do you want to talk to?').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The same on a short viewport (a phone with its keyboard up, or turned on its side): the first rows
    // have to stay reachable by scrolling.
    name: 'chat-new-short',
    title: 'New chat, employee picker, short viewport',
    heights: { desktop: 420, narrow: 420 },
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'New chat' }).first().click()
      await page.getByText('Who do you want to talk to?').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(500)
    },
  },
  {
    // The header's More options menu.
    name: 'chat-header-menu',
    title: 'Chat header menu',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'More options' }).locator('visible=true').first().click()
      await page.getByText('Open beside').locator('visible=true').first().waitFor({ timeout: 5_000 })
      await page.waitForTimeout(500)
    },
  },
]
