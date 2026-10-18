// The org map and what opens from it, each photographed with the seeded org (seed-org.mjs). They sit
// in their own file so screens.mjs stays under the size ratchet; it spreads them into SCREENS.
const READY = 'Engineering Lead'

export const ORG_SCREENS = [
  {
    // The map: department groups, glass-tint nodes, edges, and the zoom controls.
    name: 'org-map',
    title: 'Org map',
    url: () => '/org',
    ready: READY,
    prepare: async (page) => {
      await page.locator('.react-flow__node').first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
  {
    // A selected employee: the detail panel beside the map (over it on a phone).
    name: 'org-employee',
    title: 'Org employee panel',
    url: () => '/org?employee=eng-platform',
    ready: 'Platform Developer',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Edit employee' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
  {
    // The employee editor, open on a manager's report.
    name: 'org-employee-editor',
    title: 'Employee editor',
    url: () => '/org?employee=eng-platform',
    ready: 'Platform Developer',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Edit employee' }).click()
      await page.getByText('Edit employee', { exact: true }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
  {
    // A department's panel, with its Scope section.
    name: 'org-department',
    title: 'Org department panel',
    url: () => '/org?department=engineering',
    ready: 'Members',
    prepare: async (page) => {
      await page.getByRole('radiogroup', { name: 'Scope' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
]
