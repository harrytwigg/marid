// Neutral fixtures for UI captures. Every string here ends up in a screenshot
// attached to a public pull request, so it must stay generic: no real names,
// hosts, paths, ids or tokens.
//
//   node seed.mjs db  <sandbox-home> <repo>   before the gateway starts
//   node seed.mjs api <sandbox-home> <base-url> after it is healthy
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const [mode, sandboxHome, third] = process.argv.slice(2)
if (!mode || !sandboxHome || !third) {
  throw new Error('usage: seed.mjs db <sandbox-home> <repo> | seed.mjs api <sandbox-home> <base-url>')
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

function seedDb(repo) {
  const requireFromJinn = createRequire(path.join(repo, 'packages/jinn/package.json'))
  const Database = requireFromJinn('better-sqlite3')
  const db = new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
  const session = db.prepare("SELECT id FROM sessions WHERE source_ref = 'sandbox:1'").get()
  if (!session) throw new Error('the sandbox --seed session sandbox:1 is missing')
  const insert = db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, seq) VALUES (?, ?, ?, ?, ?, ?)')
  const start = Date.now() - 10 * 60_000
  CONVERSATION.forEach(([role, content], i) => {
    insert.run(crypto.randomUUID(), session.id, role, content, start + i * 60_000, i + 1)
  })
  db.prepare('UPDATE sessions SET total_turns = 2, last_activity = ? WHERE id = ?').run(new Date().toISOString(), session.id)
  db.close()
}

const TODOS = [
  { title: 'Draft the release checklist', priority: 1, status: 'executing' },
  { title: 'Review the onboarding copy', priority: 2, status: 'in_review' },
  { title: 'Tidy the settings layout', priority: 2 },
  { title: 'Add keyboard shortcuts to the board', priority: 3 },
  { title: 'Investigate slow search results', priority: 1, status: 'blocked' },
  { title: 'Write the accessibility notes', priority: 2 },
]

async function seedApi(baseUrl) {
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
  const sessions = await call('GET', '/api/sessions')
  const list = Array.isArray(sessions) ? sessions : sessions.sessions ?? []
  const chat = list.find((s) => s.sourceRef === 'sandbox:1' || s.title === '#1 - Chat layout QA')
  // The capture reads ids from here so screens can be addressed without
  // printing them anywhere a screenshot could show.
  fs.writeFileSync(path.join(sandboxHome, 'ui-capture-fixtures.json'), JSON.stringify({ todos: created, chatSession: chat?.id ?? null }, null, 2))
}

if (mode === 'db') seedDb(third)
else if (mode === 'api') await seedApi(third)
else throw new Error(`unknown mode ${mode}`)
