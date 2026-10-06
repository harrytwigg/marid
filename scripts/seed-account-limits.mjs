import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Seeds the account limits sandbox for the one unmocked pass: a second local Claude
// account, its employee, and a health record putting that account at its limit, so the
// real gateway's /api/engine-limits answers with an `accounts` list the page draws.
//   side-dev   on a named profile in the throwaway host home (not signed in)
//   eng-dev    on the gateway's own profile
const [sandboxHome, hostHome] = process.argv.slice(2)
if (!sandboxHome || !hostHome) throw new Error('usage: seed-account-limits.mjs <sandbox-home> <host-home>')

const friend = path.join(hostHome, '.claude-friend')
fs.mkdirSync(friend, { recursive: true })
const key = crypto.createHash('sha256').update(friend.normalize('NFC')).digest('hex').slice(0, 8)

function employee(dept, name, extra = '') {
  fs.mkdirSync(path.join(sandboxHome, 'org', dept), { recursive: true })
  fs.writeFileSync(path.join(sandboxHome, 'org', dept, `${name}.yaml`),
    [`name: ${name}`, `displayName: ${name}`, 'rank: employee', 'engine: claude', 'model: opus', extra, 'persona: |', `  You are ${name}.`, '']
      .filter((line) => line !== '').join('\n'))
}
employee('side-project', 'side-dev', `claudeConfigDir: ${friend}`)
employee('engineering', 'eng-dev')

const until = new Date(Date.now() + 3 * 3600_000).toISOString()
fs.mkdirSync(path.join(sandboxHome, 'tmp'), { recursive: true })
fs.writeFileSync(path.join(sandboxHome, 'tmp', 'engine-health.json'), JSON.stringify({
  [`claude:${key}`]: { state: 'exhausted', until, recheckAt: until, reason: 'Claude usage limit', observedAt: new Date().toISOString() },
}, null, 2))
fs.writeFileSync(path.join(sandboxHome, 'account-limits-seed.json'), JSON.stringify({ friend, account: `claude:${key}` }, null, 2))
