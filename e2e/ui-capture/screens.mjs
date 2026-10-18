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
