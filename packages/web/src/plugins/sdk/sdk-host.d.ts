/**
 * The typed verb tier of `@jinn/plugin-sdk`, split out of `sdk.d.ts` and
 * re-exported from it, so the one file a plugin author reads stays one file.
 *
 * Every payload below is spelled out rather than imported: the gateway's own
 * Todo and note types live in a package a plugin cannot install, and
 * naming them would put the app's internals into this contract.
 *
 * v1 grants every verb; the union below is the vocabulary a grant is written in.
 */

export type PluginHostVerb =
  | 'todos.list'
  | 'todos.create'
  | 'todos.comment'
  | 'sessions.spawn'
  | 'employees.list'
  | 'notify'
  | 'notes.list'
  | 'notes.read'
  | 'notes.create'
  | 'connectors.send'
  | 'cron.jobs'
  | 'cron.runs'
  | 'knowledge.search'

/** The eight states a Todo can be in, as the gateway spells them. */
export type HostTodoStatus =
  | 'backlog'
  | 'assigned'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'escalated'
  | 'cancelled'

/** A Todo as the list verb returns it: the columns a board renders. */
export interface HostTodo {
  id: string
  title: string
  status: HostTodoStatus
  assignee: string | null
  department: string | null
  parentId: string | null
  updatedAt: string
}

export interface HostTodoFilter {
  status?: HostTodoStatus
  assignee?: string
  /** Only parentless Todos — the objective view, without their sub-tasks. */
  rootsOnly?: boolean
  /** Defaults to 20; the gateway caps the page at 100. */
  limit?: number
}

/** What a plugin may set when it mints a Todo. Provenance is absent by design:
 *  the gateway stamps it, so a plugin cannot claim another author. */
export interface HostTodoDraft {
  title: string
  body?: string
  department?: string
  parentId?: string
  /** 0 (highest) to 3 (lowest); the gateway defaults to 2. */
  priority?: number
}

export interface HostTodoComment {
  id: string
  workItemId: string
  author: string
  body: string
  createdAt: string
}

export interface HostSessionSpawn {
  prompt: string
  /** An employee from the org. Omitted, the session runs on gateway defaults. */
  employee?: string
  engine?: string
  model?: string
}

export interface HostSession {
  id: string
  engine: string
  employee: string | null
  status: string
  title: string | null
}

export interface HostEmployee {
  name: string
  displayName: string
  department: string
  rank: string
  engine: string
  model: string
  /** The persona's first line, when short enough to be a label. */
  role?: string
}

/** A note as the list verb returns it: the row a browser renders, without the
 *  body, which `notes.read` fetches on its own. */
export interface HostNote {
  path: string
  title: string
  /** The first lines of the body, as the gateway trims them. */
  preview: string
  /** The empty string for a note at the top level. */
  folder: string
  updatedAt: string
  /** The version an update must name to win; opaque to a plugin. */
  revision: string
}

/** A note with its Markdown, as `notes.read` returns it. */
export interface HostNoteContent extends HostNote {
  body: string
}

export interface HostNoteDraft {
  title: string
  body: string
  /** A folder under the notes root. Omitted, the note lands at the top level. */
  folder?: string
}

export interface HostConnectorMessage {
  /** The channel as that connector spells it — a Slack channel id, a chat id. */
  channel: string
  text: string
  /** Reply into a thread rather than to the channel, where the connector has
   *  threads at all. */
  thread?: string
}

/** A cron job as the read tier exposes it. The prompt, the model and the
 *  delivery target are deliberately absent, exactly as they are from
 *  `GET /api/cron` — a plugin that can list jobs is not thereby able to read
 *  what they say. `lastRun` is absent for a different reason: it costs a file
 *  read per job, which the in-process half would have to do too, and
 *  `cron.runs` already answers it. */
export interface HostCronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  employee: string | null
  engine: string | null
  timezone: string | null
}

/** One past fire of a cron job. Every field is optional because the summariser
 *  omits anything a run log did not record in the shape it expects, rather than
 *  inventing a value for it. */
export interface HostCronRun {
  id?: string
  jobId?: string
  timestamp?: string
  startedAt?: string
  finishedAt?: string
  sessionKey?: string
  status?: 'success' | 'error' | 'started' | 'skipped' | 'duplicate' | 'expired'
  exitCode?: number
  durationMs?: number
  duration?: string
}

export interface HostKnowledgeResult {
  path: string
  title: string
  /** A window around the match, with the matched token wrapped in «». */
  snippet: string
  /** Occurrences across the path and the content, which is the sort key. */
  matchCount: number
}

export interface PluginHostTodos {
  list(filter?: HostTodoFilter): Promise<HostTodo[]>
  create(draft: HostTodoDraft): Promise<HostTodo>
  comment(todoId: string, body: string): Promise<HostTodoComment>
}

export interface PluginHostSessions {
  /** Start a session and its first turn. Resolves once the row exists. */
  spawn(request: HostSessionSpawn): Promise<HostSession>
}

export interface PluginHostEmployees {
  list(): Promise<HostEmployee[]>
}

export interface PluginHostNotes {
  /** Every note, or only those matching `query` when one is given. */
  list(query?: string): Promise<HostNote[]>
  read(notePath: string): Promise<HostNoteContent>
  /** Answers the note it wrote, body included — the gateway re-reads the file
   *  after writing it. */
  create(draft: HostNoteDraft): Promise<HostNoteContent>
}

export interface PluginHostConnectors {
  /** Send through a configured connector, named as `config.yaml` names it. */
  send(connector: string, message: HostConnectorMessage): Promise<void>
}

export interface PluginHostCron {
  jobs(): Promise<HostCronJob[]>
  /** The most recent runs of one job, newest first; the gateway defaults to 20. */
  runs(jobId: string, limit?: number): Promise<HostCronRun[]>
}

export interface PluginHostKnowledge {
  search(query: string): Promise<HostKnowledgeResult[]>
}
