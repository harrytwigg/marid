// Fixtures for the settings-family screens: a few skills, cron jobs with run history, and a small
// notes folder, written into the sandbox home before the gateway starts. The names are generic,
// because the images go on public pull requests.
import fs from 'node:fs'
import path from 'node:path'

const SKILLS = [
  ['release-notes', 'Draft release notes from a list of merged changes.', 'Group the changes by area and keep each line to one sentence.'],
  ['triage', 'Sort incoming reports by severity and owner.', 'Read the report, label it, and name the next step.'],
  ['changelog-check', 'Check that the changelog names every user-facing change.', 'Compare the changelog with the merged changes and list what is missing.'],
]

const DAY = 86_400_000

const JOBS = [
  { id: 'daily-digest', name: 'Daily digest', schedule: '0 9 * * *', enabled: true, prompt: 'Summarise yesterday\'s activity in five lines.', runs: ['success', 'success', 'error', 'success'] },
  { id: 'weekly-review', name: 'Weekly review', schedule: '0 10 * * 1', enabled: true, prompt: 'List what shipped this week and what is blocked.', runs: ['success'] },
  { id: 'nightly-cleanup', name: 'Nightly cleanup', schedule: '30 2 * * *', enabled: false, prompt: 'Tidy up stale drafts.', runs: [] },
]

const NOTES = [
  ['product/brief.md', '# Product brief\n\nA short note on what the next release is for.\n\n- Faster start\n- Calmer layout\n- Clearer settings\n'],
  ['product/research/interviews.md', '# Interview notes\n\nThree themes came up: speed, clarity and trust.\n'],
  ['meetings/weekly.md', '# Weekly sync\n\n1. Review the board\n2. Pick the next sprint goal\n'],
  ['scratch.md', '# Scratch\n\nA loose idea to come back to.\n'],
]

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function writeSkills(home) {
  for (const [name, description, body] of SKILLS) {
    write(path.join(home, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`)
  }
}

function writeCron(home) {
  const jobs = JOBS.map(({ id, name, enabled, schedule, prompt }) => ({ id, name, enabled, schedule, prompt, engine: 'claude', model: 'sonnet' }))
  write(path.join(home, 'cron', 'jobs.json'), `${JSON.stringify(jobs, null, 2)}\n`)
  for (const { id, runs } of JOBS) {
    const lines = runs.map((status, i) => JSON.stringify({
      timestamp: new Date(Date.now() - (i + 1) * DAY).toISOString(),
      sessionKey: `cron:${id}:${i}`,
      sessionId: null,
      status,
      durationMs: 42_000 + i * 9_000,
      error: status === 'error' ? 'The engine did not answer in time.' : null,
    }))
    if (lines.length) write(path.join(home, 'cron', 'runs', `${id}.jsonl`), `${lines.reverse().join('\n')}\n`)
  }
}

function writeNotes(home) {
  // Distinct modified times, so the list's newest-first order is the same on every capture.
  NOTES.forEach(([rel, text], i) => {
    const file = path.join(home, 'knowledge', rel)
    write(file, text)
    const at = new Date(Date.now() - (i + 1) * 3_600_000)
    fs.utimesSync(file, at, at)
  })
  // Notes are off by default; the route redirects away until the gateway enables them.
  const file = path.join(home, 'config.yaml')
  const yaml = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, /^\s+notesEnabled:/m.test(yaml)
    ? yaml.replace(/^(\s+notesEnabled:).*$/m, '$1 true')
    : yaml.replace(/^gateway:\s*$/m, 'gateway:\n  notesEnabled: true'))
}

export function writePages(sandboxHome) {
  writeSkills(sandboxHome)
  writeCron(sandboxHome)
  writeNotes(sandboxHome)
}
