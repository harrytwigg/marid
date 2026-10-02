/**
 * The typed verb tier of the host API, in the browser — one module per domain,
 * all of them going through `request.ts` and nothing else.
 *
 * Import it as `./host-verbs`, the path it had when it was one file.
 */
export { connectors } from './connectors'
export type { HostConnectorMessage, PluginHostConnectors } from './connectors'
export { cron } from './cron'
export type { HostCronJob, HostCronRun, PluginHostCron } from './cron'
export { employees } from './employees'
export type { HostEmployee, PluginHostEmployees } from './employees'
export { knowledge } from './knowledge'
export type { HostKnowledgeResult, PluginHostKnowledge } from './knowledge'
export { notes } from './notes'
export type { HostNote, HostNoteContent, HostNoteDraft, PluginHostNotes } from './notes'
export { sessions } from './sessions'
export type { HostSession, HostSessionSpawn, PluginHostSessions } from './sessions'
export { todos } from './todos'
export type {
  HostTodo,
  HostTodoComment,
  HostTodoDraft,
  HostTodoFilter,
  HostTodoStatus,
  PluginHostTodos,
} from './todos'
