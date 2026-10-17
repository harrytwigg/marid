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
]

export const THEMES = ['light', 'dark']

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
]
