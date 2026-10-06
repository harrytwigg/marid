import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
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

// a brand-new refused file: it has no last good scope, so the department is held as dedicated.
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
