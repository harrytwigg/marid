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
    // The map zoomed in on a phone, where a node's name has to stay readable beside its badges: the
    // seeded org has long, near-identical names and an opencode report. Fit-to-view is too small to see.
    name: 'org-map-zoomed',
    title: 'Org map, zoomed',
    url: () => '/org',
    ready: READY,
    viewports: ['narrow'],
    prepare: async (page) => {
      const node = page.locator('.react-flow__node', { hasText: 'Principal Developer' }).first()
      await node.waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
      const box = await node.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -900)
      await page.keyboard.up('Control')
      await page.waitForTimeout(900)
    },
  },
  ...[
    // Selection reveals a card's model (so does hover, which the capture browser does not send). It
    // must be readable in full beside the badges: a short model under a profile badge, and the
    // longest seeded model on an opencode card.
    ['org-map-model', 'Org map, model shown', 'eng-principal-qa', 'Principal Developer QA'],
    ['org-map-model-long', 'Org map, long model shown', 'eng-junior-qa', 'Junior Developer QA'],
  ].map(([name, title, employee, text]) => ({
    name,
    title,
    url: () => `/org?employee=${employee}`,
    ready: READY,
    viewports: ['desktop'],
    prepare: async (page) => {
      const node = page.locator('.react-flow__node', { hasText: text }).first()
      await node.waitFor({ timeout: 10_000 })
      await page.getByRole('button', { name: 'Edit employee' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
      const box = await node.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -500)
      await page.keyboard.up('Control')
      await page.waitForTimeout(900)
    },
  })),
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
      await page.getByText('Display name', { exact: true }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
  {
    // A department's panel, with its Scope section.
    name: 'org-department',
    title: 'Org department panel',
    url: () => '/org?department=engineering',
    ready: 'Engineering Lead',
    prepare: async (page) => {
      await page.getByRole('radiogroup', { name: 'Scope' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(900)
    },
  },
]
