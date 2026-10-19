// The settings-family routes: settings (top and a lower section), plugins, skills, cron, logs, limits,
// auto-dispatch, notes and more. They sit in their own file so screens.mjs stays under the size
// ratchet; it spreads them into SCREENS. Skills, cron and notes read the fixtures in seed-pages.mjs.

// A heading brought to the top of the scroll area, for a section below the fold.
const scrollTo = (text) => async (page) => {
  await page.getByText(text, { exact: true }).locator('visible=true').first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(500)
}

export const PAGE_SCREENS = [
  {
    name: 'settings-engines',
    title: 'Settings, engines and sessions',
    url: () => '/settings',
    ready: 'Appearance',
    prepare: scrollTo('Sessions'),
  },
  {
    name: 'settings-connectors',
    title: 'Settings, connectors',
    url: () => '/settings',
    ready: 'Appearance',
    prepare: scrollTo('Connectors'),
  },
  {
    name: 'settings-plugins',
    title: 'Plugin settings',
    url: () => '/settings/plugins',
    ready: 'Plugins',
  },
  {
    name: 'skills',
    title: 'Skills',
    url: () => '/skills',
    ready: 'release-notes',
  },
  {
    name: 'skill-detail',
    title: 'Skill detail',
    url: () => '/skills/release-notes',
    ready: 'Group the changes by area',
  },
  {
    name: 'cron',
    title: 'Cron jobs',
    url: () => '/cron',
    ready: 'Daily digest',
  },
  {
    name: 'cron-detail',
    title: 'Cron job detail',
    url: () => '/cron/daily-digest',
    ready: 'Daily digest',
    prepare: async (page) => {
      await page.waitForTimeout(800)
    },
  },
  {
    name: 'logs',
    title: 'Logs',
    url: () => '/logs',
    ready: 'Activity Console',
    // The gateway's own startup lines name the sandbox's paths; the cron lines do not.
    prepare: async (page) => {
      await page.getByPlaceholder(/^Search logs/).fill('cron')
      await page.waitForTimeout(500)
    },
  },
  {
    name: 'limits',
    title: 'Limits',
    url: () => '/limits',
    ready: 'Engine usage windows and quotas',
  },
  {
    name: 'auto-dispatch',
    title: 'Auto-dispatch',
    url: () => '/auto-dispatch',
    ready: 'The board walk',
    // The rules line names a path inside the sandbox.
    prepare: async (page) => {
      await page.evaluate(() => {
        for (const code of document.querySelectorAll('code')) code.textContent = 'board-walk.md'
      })
    },
  },
  {
    name: 'hooks',
    title: 'Hooks',
    url: () => '/hooks',
    ready: 'review-merge',
  },
  {
    name: 'notes',
    title: 'Notes list',
    url: () => '/notes/all',
    ready: 'Product brief',
  },
  {
    name: 'notes-editor',
    title: 'Note editor',
    url: () => '/notes/all/n/product/brief',
    ready: 'A short note on what the next release is for',
  },
  {
    name: 'more',
    title: 'More',
    url: () => '/more',
    ready: 'More',
  },
]

