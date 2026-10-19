// Neutral fixtures for UI captures. Every string here ends up in a screenshot
// attached to a public pull request, so it must stay generic: no real names,
// hosts, paths, ids or tokens.
//
//   node seed.mjs db  <sandbox-home> <repo>   before the gateway starts
//   node seed.mjs api <sandbox-home> <base-url> <repo> after it is healthy
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { writeOrg } from './seed-org.mjs'
import { writePages } from './seed-pages.mjs'

const [mode, sandboxHome, third, fourth] = process.argv.slice(2)
if (!mode || !sandboxHome || !third) {
  throw new Error('usage: seed.mjs db <sandbox-home> <repo> | seed.mjs api <sandbox-home> <base-url> <repo>')
}

const ASSISTANT_REPLY = [
  'Here is the plan for the release checklist.',
  '',
  '1. **Freeze** the branch and tag a release candidate.',
  '2. Run the smoke suite against the candidate.',
  '3. Publish the notes once the checks are green.',
  '',
  '```ts',
  'export function nextVersion(current: string): string {',
  "  const [major, minor] = current.split('.').map(Number)",
  '  return `${major}.${minor + 1}.0`',
  '}',
  '```',
  '',
  'I have left the rollout window open so the team can pick a time.',
].join('\n')

const CONVERSATION = [
  ['user', 'Can you draft the release checklist for the next minor version?'],
  ['assistant', ASSISTANT_REPLY],
  ['user', 'Looks good. Add a step for the changelog.'],
  ['assistant', 'Added: **4. Update the changelog** with the user-facing changes, grouped by area.'],
]

// JINN_CAPTURE_MESSAGES=<n> pads the chat with generic filler up to n messages, for the scroll
// measurement. The extra turns vary in length and shape (prose, lists, code) like a real thread.
const FILLER = [
  ['user', 'Can you walk me through the next step?'],
  ['assistant', ['Sure. There are three things to settle first:', '', '- the order the checks run in', '- which checks may run in parallel', '- what blocks the release if one fails', '', 'I would start with the first and confirm it before moving on.'].join('\n')],
  ['user', 'Show me how the check could be written.'],
  ['assistant', ['Something like this:', '', '```ts', 'export async function runChecks(checks: Array<() => Promise<boolean>>): Promise<boolean> {', '  for (const check of checks) {', '    if (!(await check())) return false', '  }', '  return true', '}', '```', '', 'It stops at the first failure, which keeps the output short.'].join('\n')],
  ['user', 'What if two of them are independent?'],
  ['assistant', 'Then they can share a batch and run together. The batch passes only when every check in it passes, and the next batch starts after that. I would keep the batches small so a failure is easy to place.'],
]

function conversation() {
  const wanted = Number(process.env.JINN_CAPTURE_MESSAGES ?? 0)
  const rows = [...CONVERSATION]
  for (let i = 0; rows.length < wanted; i += 1) rows.push(FILLER[i % FILLER.length])
  return rows
}

// The "Delegation flow" chat: a short exchange with delegation cards in each state, for the card's
// capture. The cards open the "Design pass" chat, so the block needs its id.
function delegationBlocks(childId, now) {
  const card = (id, status, title, extra) => ({
    id, type: 'delegation', version: 1, status, title,
    payload: { employee: 'reviewer', employeeDisplay: 'Reviewer', title, childSessionId: childId, workItemId: 'fixture-item', dispatchedAt: now - 5 * 60_000, ...extra },
  })
  return [
    card('card-done', 'done', 'Review the release checklist for gaps', { repliedAt: now - 2 * 60_000 }),
    card('card-running', 'running', 'Check the changelog wording against the style notes'),
    {
      id: 'row-follow-up', type: 'dispatch', version: 1,
      payload: { targetSessionId: childId, employee: 'reviewer', employeeDisplay: 'Reviewer', preview: 'Any word on the changelog notes?', sentAt: now - 60_000 },
    },
    {
      id: 'activity-todo', type: 'todo-activity', version: 1, status: 'running', title: 'Draft the release checklist',
      payload: { todoId: 'SAN-1', action: 'status', status: 'executing', assignee: 'reviewer', updatedAt: new Date(now - 90_000).toISOString(), preview: 'Moved to executing' },
    },
  ]
}

function seedDelegationChat(db) {
  const session = db.prepare("SELECT id FROM sessions WHERE source_ref = 'sandbox:2'").get()
  const child = db.prepare("SELECT id FROM sessions WHERE source_ref = 'sandbox:3'").get()
  if (!session || !child) return
  const now = Date.now()
  const insert = db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, seq, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const rows = [
    ['user', 'Ask the reviewer to look over the checklist and check the changelog wording too.', null],
    ['assistant', 'Done. I handed both to the reviewer:', JSON.stringify(delegationBlocks(child.id, now))],
    ['assistant', 'I will fold their notes into the checklist when they reply.', null],
  ]
  rows.forEach(([role, content, blocks], i) => insert.run(crypto.randomUUID(), session.id, role, content, now - (rows.length - i) * 60_000, i + 1, blocks))
  db.prepare('UPDATE sessions SET total_turns = 2, last_activity = ? WHERE id = ?').run(new Date().toISOString(), session.id)
}

function openDb(repo) {
  const requireFromJinn = createRequire(path.join(repo, 'packages/jinn/package.json'))
  const Database = requireFromJinn('better-sqlite3')
  return new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
}

function seedDb(repo) {
  if (process.env.JINN_CAPTURE_SEED_ORG) writeOrg(sandboxHome)
  if (process.env.JINN_CAPTURE_SEED_PAGES) writePages(sandboxHome)
  const db = openDb(repo)
  const session = db.prepare("SELECT id FROM sessions WHERE source_ref = 'sandbox:1'").get()
  if (!session) throw new Error('the sandbox --seed session sandbox:1 is missing')
  const insert = db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, seq) VALUES (?, ?, ?, ?, ?, ?)')
  const start = Date.now() - 10 * 60_000
  conversation().forEach(([role, content], i) => {
    insert.run(crypto.randomUUID(), session.id, role, content, start + i * 60_000, i + 1)
  })
  db.prepare('UPDATE sessions SET total_turns = ?, last_activity = ? WHERE id = ?').run(conversation().length === CONVERSATION.length ? 2 : Math.ceil(conversation().length / 2), new Date().toISOString(), session.id)
  seedDelegationChat(db)
  db.close()
}

// A closing turn that names a Todo, so the thread has a mention to hover. It can only be written
// once the Todo exists, hence from the api step; the gateway has the database open and reads the
// message from it on the next load.
function mentionTodo(repo, sessionId, todoId) {
  if (!repo) throw new Error('seed.mjs api needs the repo to write the mention')
  const db = openDb(repo)
  const last = db.prepare('SELECT MAX(seq) AS seq, MAX(timestamp) AS at FROM messages WHERE session_id = ?').get(sessionId)
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, seq) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), sessionId, 'assistant', `Tracking the checklist in ${todoId}, which is in progress.`, last.at + 1_000, last.seq + 1)
  db.close()
}

const TODOS = [
  { title: 'Draft the release checklist', priority: 1, status: 'executing' },
  { title: 'Review the onboarding copy', priority: 2, status: 'in_review' },
  { title: 'Tidy the settings layout', priority: 2 },
  { title: 'Add keyboard shortcuts to the board', priority: 3 },
  { title: 'Investigate slow search results', priority: 1, status: 'blocked' },
  { title: 'Write the accessibility notes', priority: 2 },
  { title: 'Publish the changelog', priority: 2, status: 'done' },
  { title: 'Retire the old export option', priority: 3, status: 'cancelled' },
]

// A plain gradient picture, written as a PNG so the lightbox has something to show without a binary in the
// repository. `hue` tells two apart.
function gradientPng(width, height, hue) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2
      row[1 + x * 3] = Math.round(40 + 160 * t * (hue === 0 ? 1 : 0.4))
      row[2 + x * 3] = Math.round(90 + 110 * (1 - t))
      row[3 + x * 3] = Math.round(200 - 120 * t * (hue === 0 ? 0.5 : 1.2))
    }
    rows.push(row)
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function seedAttachments(baseUrl, token, todoId) {
  for (const [index, name] of ['overview.png', 'detail.png'].entries()) {
    const form = new FormData()
    form.append('file', new File([gradientPng(960, 600, index)], name, { type: 'image/png' }))
    const res = await fetch(`${baseUrl}/api/work-items/${todoId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })
    if (!res.ok) console.warn(`attachment ${name} skipped: ${res.status}`)
  }
}

// Two sprints, one running with a Todo in it, so the planner has a list to show.
async function seedSprints(call, todoIds) {
  const active = await call('POST', '/api/sprints', { name: 'Sprint 1', goal: 'Ship the release candidate' })
  await call('POST', '/api/sprints', { name: 'Sprint 2', goal: 'Polish the board' })
  await call('PUT', `/api/work-items/${todoIds[0]}/sprint`, { sprint: active.sprint.id }).catch(() => {})
  await call('POST', `/api/sprints/${active.sprint.id}/start`).catch((err) => console.warn(`sprint start skipped: ${err.message}`))
}

const sandboxSession = (list, n, title) => list.find((s) => s.sourceRef === `sandbox:${n}` || s.title === `#${n} - ${title}`)

// The capture reads ids from here so screens can be addressed without printing them anywhere a
// screenshot could show.
function writeFixtures(repo, list, todos) {
  const chat = sandboxSession(list, 1, 'Chat layout QA')
  const delegation = sandboxSession(list, 2, 'Delegation flow')
  if (chat && todos[0]) mentionTodo(repo, chat.id, todos[0])
  const ids = { todos, chatSession: chat?.id ?? null, delegationSession: delegation?.id ?? null }
  fs.writeFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), JSON.stringify(ids, null, 2))
}

async function seedApi(baseUrl, repo) {
  const { token } = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'gateway.json'), 'utf8'))
  const call = async (method, url, body) => {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`)
    return res.json()
  }
  const created = []
  for (const todo of TODOS) {
    const { workItem } = await call('POST', '/api/work-items', {
      title: todo.title,
      priority: todo.priority,
      body: 'Neutral fixture used for interface captures.',
    })
    created.push(workItem.id)
    if (todo.status) {
      const note = todo.status === 'blocked' ? 'Waiting on a decision.' : 'Fixture status.'
      await call('POST', `/api/work-items/${workItem.id}/status`, { status: todo.status, note }).catch((err) => {
        console.warn(`status ${todo.status} for ${workItem.id} skipped: ${err.message}`)
      })
    }
  }
  await seedAttachments(baseUrl, token, created[0])
  await seedSprints(call, created).catch((err) => console.warn(`sprints skipped: ${err.message}`))
  const sessions = await call('GET', '/api/sessions')
  const list = Array.isArray(sessions) ? sessions : sessions.sessions ?? []
  writeFixtures(repo, list, created)
}

if (mode === 'db') seedDb(third)
else if (mode === 'api') await seedApi(third, fourth)
else throw new Error(`unknown mode ${mode}`)
