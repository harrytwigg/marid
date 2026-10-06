import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const [sandboxHome] = process.argv.slice(2)
if (!sandboxHome) throw new Error('usage: seed-departments.mjs <sandbox-home>')

// The sandbox host home is the sandbox home's parent: the gateway's os.homedir() is that
// directory, which is what the working-directory rule measures a work tree against.
const hostHome = path.dirname(sandboxHome)
const org = path.join(sandboxHome, 'org')

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

function employee(department, name, rank, extra = []) {
  write(path.join(org, department, `${name}.yaml`), [
    `name: ${name}`,
    `displayName: ${name}`,
    `department: ${department}`,
    `rank: ${rank}`,
    'engine: claude',
    'model: sonnet',
    ...extra,
    `persona: Works on ${department}.`,
  ])
}

// A real work tree for the scoped department's working directory. Names and paths are invented.
const workdir = path.join(hostHome, 'code', 'side-project')
fs.mkdirSync(workdir, { recursive: true })
execFileSync('git', ['init', '-q', workdir], { stdio: 'ignore' })

// open: no scope, so no badge.
write(path.join(org, 'engineering', 'department.yaml'), [
  'name: engineering',
  'displayName: Engineering',
  'description: Builds and maintains the product.',
])
employee('engineering', 'eng-lead', 'manager')
employee('engineering', 'eng-dev', 'employee', ['reportsTo: eng-lead'])

// scoped, with every extra the panel shows.
write(path.join(org, 'side-project', 'department.yaml'), [
  'name: side-project',
  'displayName: Side project',
  "description: A friend's side project",
  'scope: scoped',
  'workdirs:',
  `  - ${workdir}`,
  'skills: [management, delegation, no-such-skill]',
  'sharedNotes: [knowledge/shared/glossary.md]',
  'instructions: department+company',
])
employee('side-project', 'side-lead', 'manager')
employee('side-project', 'side-dev', 'employee', ['reportsTo: side-lead'])

// dedicated.
write(path.join(org, 'friend-lab', 'department.yaml'), [
  'name: friend-lab',
  'displayName: Friend lab',
  'description: Closed to everyone but its own members.',
  'scope: dedicated',
  'skills: []',
])
employee('friend-lab', 'friend-lead', 'manager')

// a refused file that asks for a scope and has never loaded: the department is held as dedicated.
write(path.join(org, 'new-lab', 'department.yaml'), ['name: some-other-lab', 'scope: scoped'])
employee('new-lab', 'new-lead', 'manager')

// scoped now; the spec breaks its file live to show a refusal that keeps the last good scope.
write(path.join(org, 'garden', 'department.yaml'), [
  'name: garden',
  'displayName: Garden',
  'description: Allotment planning.',
  'scope: scoped',
])
employee('garden', 'garden-lead', 'manager')

// open, and the one the spec changes the scope of: a save has to land somewhere that no other check reads.
write(path.join(org, 'workshop', 'department.yaml'), ['name: workshop', 'displayName: Workshop', 'description: Open until the spec scopes it.'])
employee('workshop', 'shop-lead', 'manager')

// Sessions, written straight into the registry the way seed-claude-profiles.mjs does. Nothing here
// starts an engine turn: every row is idle, and the sandbox never runs one.
//   side-dev's are bound to side-project (the badge); eng-dev's is not (no badge).
// The spec links the first bound one to a Todo once the Todo exists, so it shows on the Todo page tree.
const Database = createRequire(path.join(import.meta.dirname, '..', 'packages', 'jinn', 'package.json'))('better-sqlite3')
const db = new Database(path.join(sandboxHome, 'sessions', 'registry.db'))
const now = Date.now()
const insert = db.prepare(`
  INSERT INTO sessions (
    id, engine, source, source_ref, connector, session_key, model, title, employee,
    prompt_excerpt, status, total_cost, total_turns, last_context_tokens,
    created_at, last_activity, scope_department
  ) VALUES (?, 'claude', 'web', ?, 'web', ?, 'sonnet', ?, ?, ?, 'idle', 0, 0, 0, ?, ?, ?)
`)
const sessions = {}
;[
  ['scoped-build', 'Fix the failing build', 'side-dev', 'side-project', 5],
  ['scoped-review', 'Review the release notes', 'side-dev', 'side-project', 12],
  ['open-plan', 'Plan the next release', 'eng-dev', null, 20],
].forEach(([key, title, who, department, minutesAgo]) => {
  const id = crypto.randomUUID()
  const at = new Date(now - Number(minutesAgo) * 60_000).toISOString()
  insert.run(id, `departments:${key}`, `web:departments:${key}`, title, who, title, at, at, department)
  sessions[key] = id
})
db.close()
fs.writeFileSync(path.join(sandboxHome, 'departments-seed.json'), JSON.stringify({ sessions }, null, 2))
