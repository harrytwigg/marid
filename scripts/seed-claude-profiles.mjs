import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// Seeds the Claude profiles sandbox: three employees and a chat for each profile state.
//   side-dev      a named profile whose directory exists but is not signed in
//   side-missing  a named profile whose directory does not exist
//   eng-dev       the gateway's own profile (no badge, no row)
// Both profile directories sit in the throwaway host home, never in the operator's.
const [sandboxHome, hostHome, repo] = process.argv.slice(2)
if (!sandboxHome || !hostHome || !repo) throw new Error('usage: seed-claude-profiles.mjs <sandbox-home> <host-home> <repo>')

const signedOut = path.join(hostHome, '.claude-friend')
const missing = path.join(hostHome, '.claude-gone')
fs.mkdirSync(signedOut, { recursive: true })

function employee(dept, name, displayName, extra = '') {
  fs.mkdirSync(path.join(sandboxHome, 'org', dept), { recursive: true })
  fs.writeFileSync(path.join(sandboxHome, 'org', dept, `${name}.yaml`), [
    `name: ${name}`,
    `displayName: ${displayName}`,
    'rank: employee',
    'engine: claude',
    'model: opus',
    extra,
    'persona: |',
    `  You are ${displayName}.`,
    '',
  ].filter((line) => line !== '').join('\n'))
}
employee('side-project', 'side-dev', 'Side Dev', `claudeConfigDir: ${signedOut}`)
employee('side-project', 'side-missing', 'Side Missing', `claudeConfigDir: ${missing}`)
employee('engineering', 'eng-dev', 'Eng Dev')

const requireFromJinn = createRequire(path.join(repo, 'packages/jinn/package.json'))
const Database = requireFromJinn('better-sqlite3')
const db = new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
const now = new Date().toISOString()
const insert = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, engine, source, source_ref, connector, session_key, model, title, employee,
    prompt_excerpt, status, total_cost, total_turns, last_context_tokens,
    created_at, last_activity
  ) VALUES (?, 'claude', 'web', ?, 'web', ?, 'opus', ?, ?, ?, 'idle', 0, 0, 0, ?, ?)
`)
const ids = {}
for (const [ref, title, who] of [
  ['profiles:1', 'Side project: not signed in', 'side-dev'],
  ['profiles:2', 'Side project: profile missing', 'side-missing'],
]) {
  const id = crypto.randomUUID()
  insert.run(id, ref, `web:${ref}`, title, who, title, now, now)
  ids[who] = id
}
db.close()
fs.writeFileSync(path.join(sandboxHome, 'claude-profiles-seed.json'), JSON.stringify({ ids, signedOut, missing }, null, 2))
