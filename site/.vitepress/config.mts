import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
// The pages live outside site/, so bare imports from them (vue) would not find site's node_modules.
const vueDir = path.dirname(createRequire(import.meta.url).resolve('vue/package.json'))

const REPO = 'https://github.com/hundredfoldhq/hundredfold'
const RAW = 'https://raw.githubusercontent.com/hundredfoldhq/hundredfold/main'

// Served from https://hundredfoldhq.github.io/hundredfold/ today. A custom domain
// serves from the root, so set SITE_BASE=/ for that build (and add the domain in Settings > Pages).
const base = normaliseBase(process.env.SITE_BASE || '/hundredfold/')

function normaliseBase(value: string): string {
  const trimmed = value.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/**
 * Pages in docs/ that are working notes, generated inventories, internal
 * design or operator-only runbooks rather than user documentation. They are not
 * built; links to them from published pages point at the file on GitHub.
 */
const EXCLUDED_DOC_DIRS = ['plans', 'qa', 'superpowers', 'design', 'adr']
const EXCLUDED_DOC_FILES = [
  'codename-compatibility.md', // how a fork survives a change of codename
  'platform.md', // typed platform intents: a code contract for contributors
  'realtime-providers.md', // dated vendor billing research
  'talk-control-coverage.md', // generated route inventory
  'talk-session-runtime.md', // internal design of the Talk runtime
  'workspace-deliverables.md', // internal build-pipeline design
]

/** The only Markdown the site reads, in place: the README, docs/*.md and the landing page. */
const PUBLISHED_ROOT_FILES = new Set(['README.md'])

function listExcluded(): string[] {
  const excluded: string[] = []
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.name === 'docs' || entry.name === 'site' || PUBLISHED_ROOT_FILES.has(entry.name)) continue
    excluded.push(entry.isDirectory() ? `${entry.name}/**` : entry.name)
  }
  for (const dir of EXCLUDED_DOC_DIRS) excluded.push(`docs/${dir}/**`)
  for (const file of EXCLUDED_DOC_FILES) excluded.push(`docs/${file}`)
  // Everything under site/ except the landing page.
  excluded.push('site/node_modules/**', 'site/public/**', 'site/README.md')
  return excluded
}

const publishedPages = new Set<string>(['README.md', 'site/index.md'])
for (const file of fs.readdirSync(path.join(repoRoot, 'docs'))) {
  if (file.endsWith('.md') && !EXCLUDED_DOC_FILES.includes(file)) publishedPages.add(`docs/${file}`)
}

const srcRoot = repoRoot
const originalOf = new Map<string, string>()

function listRewrites(): Record<string, string> {
  const rewrites: Record<string, string> = { 'README.md': 'getting-started.md', 'site/index.md': 'index.md' }
  for (const page of publishedPages) {
    if (page.startsWith('docs/')) rewrites[page] = page.slice('docs/'.length)
  }
  for (const [from, to] of Object.entries(rewrites)) originalOf.set(to, from)
  return rewrites
}

/**
 * The docs are written for GitHub, so they link to repo files (`../NOTICE`,
 * `packages/...`) and to docs that this site does not publish. Rather than
 * editing them, send every such link to the file on GitHub; links between
 * published pages stay local and are checked by the build. Raw HTML images
 * (`<img src="assets/...">`) are pointed at the same repo.
 */
function repoLinks(md: MarkdownIt) {
  md.core.ruler.push('repo-links', (state) => {
    const served = (state.env as { path?: string }).path
    if (!served) return
    // env.path is the rewritten location; relative links resolve from the real file.
    const original = originalOf.get(path.relative(srcRoot, served).split(path.sep).join('/'))
    if (!original) return
    const sourceDir = path.dirname(path.join(repoRoot, original))
    if (original !== 'site/index.md') wrapVPre(state)
    for (const block of state.tokens) {
      for (const token of block.children ?? [block]) {
        if (token.type === 'link_open') {
          const href = token.attrGet('href')
          const target = href && resolveRepoTarget(sourceDir, href)
          if (target) token.attrSet('href', target)
        } else if (token.type === 'html_block' || token.type === 'html_inline') {
          token.content = token.content.replace(/(\ssrc=")(?!https?:|\/|data:)([^"]+)"/g, (_m, attr: string, src: string) => {
            const abs = path.resolve(sourceDir, src)
            return `${attr}${RAW}/${path.relative(repoRoot, abs).split(path.sep).join('/')}"`
          })
        }
      }
    }
  })
}

/**
 * The docs show template syntax such as `{{ todo.title }}` in prose. Vue would
 * evaluate it, so published docs render with `v-pre`; only the landing page uses components.
 */
function wrapVPre(state: { tokens: Token[]; Token: new (type: string, tag: string, nesting: number) => Token }) {
  const open = new state.Token('html_block', '', 0)
  open.content = '<div v-pre>\n'
  const close = new state.Token('html_block', '', 0)
  close.content = '</div>\n'
  state.tokens.unshift(open)
  state.tokens.push(close)
}

const HTML_TAGS = new Set(
  'a abbr b big blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small source span strike strong sub summary sup table tbody td tfoot th thead tr u ul video'.split(' '),
)

/**
 * GitHub shows `<host>` or `(<email>)` in prose as text; Vue would try to mount
 * it as a component. Turn any inline tag that is not real HTML back into text.
 */
function literalPlaceholders(md: MarkdownIt) {
  md.core.ruler.push('literal-placeholders', (state) => {
    for (const block of state.tokens) {
      if (block.type === 'html_block') {
        const name = /^\s*<\/?([A-Za-z][\w:-]*)/.exec(block.content)?.[1]?.toLowerCase()
        if (name && !HTML_TAGS.has(name)) block.content = `<p>${md.utils.escapeHtml(block.content.trim())}</p>\n`
      }
      for (const token of block.children ?? []) {
        if (token.type !== 'html_inline') continue
        const name = /^<\/?([A-Za-z][\w:-]*)/.exec(token.content)?.[1]?.toLowerCase()
        if (name && !HTML_TAGS.has(name)) token.type = 'text'
      }
    }
  })
}

function resolveRepoTarget(sourceDir: string, href: string): string | undefined {
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return undefined
  const [file, hash] = href.split('#')
  const abs = path.resolve(sourceDir, decodeURI(file))
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/')
  if (rel.startsWith('..')) return undefined
  // Served paths differ from repo paths (README.md is /getting-started), so link by route.
  if (publishedPages.has(rel)) return `/${rewrites[rel].replace(/(^|\/)index\.md$|\.md$/, '')}${hash ? `#${hash}` : ''}`
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory()
  return `${REPO}/${isDir ? 'tree' : 'blob'}/main/${rel}${hash ? `#${hash}` : ''}`
}

const rewrites = listRewrites()

export default defineConfig({
  title: 'Hundredfold',
  description: 'Run your AI agents as a company.',
  lang: 'en',
  base,
  srcDir: '..',
  srcExclude: listExcluded(),
  rewrites: rewrites,
  cleanUrls: true,
  // Local addresses in the quickstart are for the reader's own machine, not pages of this site.
  ignoreDeadLinks: [/^https?:\/\/localhost(:\d+)?/],
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#0B1422' }],
  ],
  markdown: {
    config: (md) => {
      repoLinks(md)
      literalPlaceholders(md)
    },
  },
  vite: {
    resolve: { alias: [{ find: /^vue\/server-renderer$/, replacement: path.join(vueDir, 'server-renderer') }, { find: /^vue$/, replacement: vueDir }] },
    publicDir: path.resolve(here, '../public'),
    server: { fs: { allow: [repoRoot] } },
  },
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Hundredfold',
    nav: [
      { text: 'Docs', link: '/getting-started' },
      { text: 'GitHub', link: REPO },
    ],
    socialLinks: [{ icon: 'github', link: REPO }],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Install and first run', link: '/getting-started' },
          { text: 'Running in Docker', link: '/docker' },
          { text: 'Behind a proxy or tunnel', link: '/behind-a-proxy' },
          { text: 'Claude sign-in on a gateway host', link: '/claude-auth' },
        ],
      },
      {
        text: 'Engines',
        items: [
          { text: 'opencode', link: '/engines-opencode' },
          { text: 'Upgrading opencode to 2', link: '/opencode-2-upgrade' },
          { text: 'Hermes', link: '/engines-hermes' },
          { text: 'Muse Code', link: '/engines-musecode' },
        ],
      },
      {
        text: 'Remote',
        items: [{ text: 'Remote (SSH) execution', link: '/remote-execution' }],
      },
      {
        text: 'Sessions',
        items: [
          { text: 'Fallback chains', link: '/fallback-chains' },
          { text: 'Per-session fallback mode', link: '/session-fallback-mode' },
          { text: 'Auto-compaction', link: '/auto-compaction' },
          { text: 'Session statuses', link: '/session-statuses' },
        ],
      },
      {
        text: 'Todos and automation',
        items: [
          { text: 'Board hooks', link: '/board-hooks' },
          { text: 'The board walk', link: '/idle-capacity' },
        ],
      },
      {
        text: 'Workspace',
        items: [
          { text: 'Terminals', link: '/terminals' },
          { text: 'The CLI terminal view', link: '/cli-terminal' },
        ],
      },
      {
        text: 'Integrations',
        items: [
          { text: 'Remote MCP connector', link: '/remote-mcp' },
          { text: 'Plugins', link: '/plugins' },
        ],
      },
      {
        text: 'Compared with Jinn',
        items: [{ text: 'Hundredfold and Jinn', link: '/marid-vs-jinn' }],
      },
    ],
    footer: {
      message: 'Built on <a href="https://github.com/hristo2612/jinn">Jinn</a> by hristo2612 and contributors (MIT).',
    },
  },
})
