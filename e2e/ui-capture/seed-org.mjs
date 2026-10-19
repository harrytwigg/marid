// A small org for the org map captures: three departments with a manager and reports each, and one
// scoped department. Written as YAML files into the sandbox home before the gateway starts. The
// names are generic job titles, because the images go on public pull requests.
import fs from 'node:fs'
import path from 'node:path'

const DEPARTMENTS = [
  { slug: 'engineering', name: 'Engineering', description: 'Builds the product.' },
  { slug: 'design', name: 'Design', description: 'Shapes how the product looks.' },
  { slug: 'research', name: 'Research', description: 'Looks into open questions.' },
  { slug: 'side-project', name: 'Side project', description: 'A small standalone effort.', scope: 'scoped' },
]

// [department, name, display name, rank, reports to, model]
const EMPLOYEES = [
  ['engineering', 'eng-lead', 'Engineering Lead', 'manager', null, 'opus'],
  ['engineering', 'eng-platform', 'Platform Developer', 'senior', 'eng-lead', 'sonnet'],
  ['engineering', 'eng-web', 'Web Developer', 'employee', 'eng-lead', 'sonnet'],
  ['engineering', 'eng-qa', 'Quality Reviewer', 'employee', 'eng-lead', 'haiku'],
  ['design', 'design-lead', 'Design Lead', 'manager', null, 'opus'],
  ['design', 'design-visual', 'Visual Designer', 'employee', 'design-lead', 'sonnet'],
  ['design', 'design-writer', 'Content Writer', 'employee', 'design-lead', 'sonnet'],
  ['research', 'research-lead', 'Research Lead', 'manager', null, 'opus'],
  ['research', 'research-analyst', 'Analyst', 'employee', 'research-lead', 'sonnet'],
  ['side-project', 'side-lead', 'Side Project Lead', 'manager', null, 'sonnet'],
]

const PERSONA = [
  'You turn a request into a small, reviewable change.',
  'Read the surrounding code first, follow its conventions, and run the checks that cover your change.',
  'Report what you did and what you are unsure about, briefly.',
]

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

export function writeOrg(sandboxHome) {
  const org = path.join(sandboxHome, 'org')
  for (const d of DEPARTMENTS) {
    write(path.join(org, d.slug, 'department.yaml'), [
      `name: ${d.slug}`, `displayName: ${d.name}`, `description: ${d.description}`, ...(d.scope ? [`scope: ${d.scope}`] : []),
    ])
  }
  for (const [department, name, displayName, rank, reportsTo, model] of EMPLOYEES) {
    write(path.join(org, department, `${name}.yaml`), [
      `name: ${name}`, `displayName: ${displayName}`, `department: ${department}`, `rank: ${rank}`,
      'engine: claude', `model: ${model}`, ...(reportsTo ? [`reportsTo: ${reportsTo}`] : []),
      'persona: |', ...PERSONA.map((line) => `  ${line}`),
    ])
  }
}
