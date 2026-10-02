import { request, write } from './request'

/** The six states a Todo can be in, as the gateway spells them. */
export type HostTodoStatus =
  | 'backlog'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'cancelled'

/** A Todo as the list endpoint returns it: the columns a board renders, not the
 *  whole stored row. */
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
  /** Only Todos with no parent — the objective view, without their sub-tasks. */
  rootsOnly?: boolean
  /** The gateway defaults to 20 and caps the page at 100. */
  limit?: number
}

/** What a plugin may set when it mints a Todo. Provenance is not on the list:
 *  the gateway stamps who created it, so a plugin cannot claim another author. */
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

export interface PluginHostTodos {
  list(filter?: HostTodoFilter): Promise<HostTodo[]>
  create(draft: HostTodoDraft): Promise<HostTodo>
  comment(todoId: string, body: string): Promise<HostTodoComment>
}

function todoQuery(filter: HostTodoFilter | undefined): string {
  const params = new URLSearchParams()
  if (filter?.status) params.set('status', filter.status)
  if (filter?.assignee) params.set('assignee', filter.assignee)
  if (filter?.rootsOnly) params.set('rootsOnly', 'true')
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const todos: PluginHostTodos = {
  async list(filter) {
    const page = await request<{ workItems: HostTodo[] }>(
      'todos.list',
      `/api/work-items${todoQuery(filter)}`,
    )
    return page.workItems
  },
  async create(draft) {
    const created = await write<{ workItem: HostTodo }>('todos.create', '/api/work-items', draft)
    return created.workItem
  },
  async comment(todoId, body) {
    const added = await write<{ comment: HostTodoComment }>(
      'todos.comment',
      `/api/work-items/${encodeURIComponent(todoId)}/comments`,
      { body },
    )
    return added.comment
  },
}
