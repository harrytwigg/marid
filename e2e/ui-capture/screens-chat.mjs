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
    // Two tabs in one pane: the chat and the Todo its last message names. A plain click on the
    // mention opens it beside the chat in the same group, which is what draws the strip — the tab
    // bar the close-all rides in.
    name: 'chat-pane-tabs',
    viewports: ['desktop'],
    title: 'Chat, a Todo tab beside it',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    prepare: async (page) => {
      await page.getByText('SAN-1', { exact: true }).first().click()
      await page.getByTestId('pane-tab-strip').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(700)
    },
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
    // A phone's new chat with an employee picked: the header names who the chat will run as.
    name: 'chat-new-picked',
    viewports: ['narrow'],
    title: 'New chat, employee picked, phone',
    url: () => '/',
    ready: 'Delegation flow',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'New chat' }).first().click()
      await page.getByText('Who do you want to talk to?').waitFor({ timeout: 10_000 })
      await page.getByRole('option', { name: /Platform Developer/ }).click()
      await page.locator('[data-chat-mobile-employee]').filter({ hasText: 'Platform Developer' }).waitFor({ timeout: 10_000 })
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
    // The "Open chat" picker beside a chat, over a long list: it must stay bounded and scroll its own
    // virtualised rows, not grow to the height of the list (the sandbox has only a few chats, so pad it).
    name: 'chat-open-beside',
    viewports: ['desktop'],
    serviceWorkers: 'block',
    title: 'Open chat picker, long list',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    setup: async (page) => {
      await page.route(/\/api\/sessions$/, async (route) => {
        const response = await route.fetch()
        const body = await response.json()
        const base = body.sessions ?? []
        const padded = Array.from({ length: 120 }, (_, i) => ({ ...base[i % base.length], id: `pad-${i}`, sessionKey: `pad-${i}`, title: `Padded chat ${i + 1}` }))
        await route.fulfill({ response, json: { ...body, sessions: [...base, ...padded] } })
      })
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'More options' }).first().click()
      await page.getByText('Open beside').first().click()
      await page.getByTestId('session-picker-search').waitFor({ timeout: 10_000 })
      await page.getByText('Padded chat 1', { exact: true }).first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(600)
      const scroll = page.getByTestId('session-picker-scroll')
      const { client, scrollHeight } = await scroll.evaluate((el) => ({ client: el.clientHeight, scrollHeight: el.scrollHeight }))
      // Bounded: a list that grows to its content has defeated the virtualiser.
      if (scrollHeight <= client || client > 900) throw new Error(`picker list is not a bounded scroller (client ${client}, scroll ${scrollHeight})`)
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
  {
    // A turn is running and two messages are parked: the queued bar must sit wholly above the composer,
    // with Send all now under the pointer. The sandbox has no engine, so the
    // session reports running and the queue is two parked rows.
    name: 'chat-queued',
    title: 'Chat with queued messages and a running turn',
    serviceWorkers: 'block',
    url: (f) => `/?session=${f.chatSession}`,
    ready: PLAN_READY,
    setup: async (page) => {
      await page.route(/\/api\/sessions\/[^/?]+(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        await route.fulfill({ response, json: { ...(await response.json()), status: 'running' } })
      })
      await page.route(/\/api\/sessions\/[^/]+\/queue$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        const row = (n) => ({ id: `queued-${n}`, sessionId: 'sandbox', prompt: `Follow-up ${n}`, status: 'pending', position: n, createdAt: new Date().toISOString(), messageId: null })
        await route.fulfill({ json: [row(1), row(2)] })
      })
    },
    prepare: async (page) => {
      const bar = page.locator('[data-queued-bar]')
      await bar.waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      const problems = await page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
        const barEl = document.querySelector('[data-queued-bar]')
        const composer = document.querySelector('[data-chat-composer]')
        const button = barEl.querySelector('button')
        const label = barEl.querySelector('span')
        const out = []
        const b = box(barEl)
        if (b.bottom > box(composer).top + 0.5) out.push(`the bar ends at ${b.bottom}, below the composer's top ${box(composer).top}`)
        for (const [name, el] of [['Send all now', button], ['the count', label]]) {
          const r = box(el)
          const cy = (r.top + r.bottom) / 2
          for (const [x, y] of [[r.left + (r.right - r.left) / 4, cy], [(r.left + r.right) / 2, r.top + 4], [(r.left + r.right) / 2, r.bottom - 4], [r.right - (r.right - r.left) / 4, cy]]) {
            const hit = document.elementFromPoint(x, y)
            if (hit !== el && !el.contains(hit)) { out.push(`${name} is covered at ${Math.round(x)},${Math.round(y)} by ${hit?.tagName.toLowerCase()}`); break }
          }
          if (r.right > window.innerWidth + 0.5 || r.left < -0.5) out.push(`${name} runs off the screen`)
        }
        return out
      })
      if (problems.length) throw new Error(`queued bar: ${problems.join('; ')}`)
      await page.getByRole('button', { name: 'Send all now' }).click({ trial: true, timeout: 3_000 })
    },
  },
]
