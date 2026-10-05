import fs from 'node:fs'
import path from 'node:path'

const [sandboxHome] = process.argv.slice(2)
if (!sandboxHome) throw new Error('usage: seed-projects.mjs <sandbox-home>')

// Two hand-written project files, so the run proves the YAML-first path: the gateway scans
// projects/ at boot with no API write involved. Names and paths are invented.
/** @type {Array<[string, string[]]>} */
const projects = [
  ['garden-planner.yaml', [
    'id: prj_0a1b2c3d4e5f',
    'name: Garden Planner',
    'description: Allotment layouts and planting calendars',
    'archived: false',
    'dedicated: false',
    'workdirs: []',
    'skills: []',
    'sharedNotes: []',
    'instructions: project',
  ]],
  ['boat-club.yaml', [
    'id: prj_1a2b3c4d5e6f',
    'name: Boat Club',
    'description: Regatta sign-ups for the sailing club',
    'archived: false',
    'dedicated: false',
    'workdirs: []',
    'skills: []',
    'sharedNotes: []',
    'instructions: project',
  ]],
]

const dir = path.join(sandboxHome, 'projects')
fs.mkdirSync(dir, { recursive: true })
for (const [file, lines] of projects) fs.writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`)
