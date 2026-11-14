import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'

const [sandboxHome, repo] = process.argv.slice(2)
if (!sandboxHome || !repo) throw new Error('usage: seed-chat-grid-drop.mjs <sandbox-home> <repo>')

const requireFromHundredfold = createRequire(path.join(repo, 'packages/hundredfold/package.json'))
const Database = requireFromHundredfold('better-sqlite3')
const db = new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
const now = new Date().toISOString()
// The sandbox's own --seed leaves three sessions (#1-#3). The drop matrix drives every pane
// count up to capForViewport and then drops one MORE to prove eviction, so the tallest case is
// the 1920x1080 cap of eight plus the evicted ninth. Seeding short does not fail loudly -- the
// matrix would simply stop below the cap and pass while never exercising it.
const rows = [
  ['sandbox:4', '#4 - Release notes'],
  ['sandbox:5', '#5 - Incident review'],
  ['sandbox:6', '#6 - Accessibility pass'],
  ['sandbox:7', '#7 - Latency budget'],
  ['sandbox:8', '#8 - Migration dry run'],
  ['sandbox:9', '#9 - Localisation sweep'],
]
const insert = db.prepare(`
  INSERT OR IGNORE INTO sessions (
    id, engine, source, source_ref, connector, session_key, model, title,
    prompt_excerpt, status, total_cost, total_turns, last_context_tokens,
    created_at, last_activity
  ) VALUES (?, 'claude', 'web', ?, 'web', ?, 'opus', ?, ?, 'idle', 0, 0, 900, ?, ?)
`)

for (const [sourceRef, title] of rows) {
  insert.run(crypto.randomUUID(), sourceRef, `web:${sourceRef}`, title, title, now, now)
}
db.close()
