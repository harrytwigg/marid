/**
 * A background sub-agent's conversation opened as a tab beside the chat that launched it. A sub-agent
 * is no session, so its tab is an id in its own namespace, as a file's is: `subagent:` followed by
 * the session it belongs to, its agent id, and the two labels its row carried. A session id never
 * carries the prefix, so the kinds cannot collide.
 */
export interface SubagentTabRef {
  /** The session whose sub-agent this is: the transcript is read through it. */
  sessionId: string
  agentId: string
  description: string | null
  agentType: string | null
}

const SUBAGENT_TAB_PREFIX = 'subagent:'

export function isSubagentTabId(tabId: string): boolean {
  return tabId.startsWith(SUBAGENT_TAB_PREFIX)
}

export function subagentTabId({ sessionId, agentId, description, agentType }: SubagentTabRef): string {
  const params = new URLSearchParams({ session: sessionId, agent: agentId })
  if (description) params.set('description', description)
  if (agentType) params.set('type', agentType)
  return `${SUBAGENT_TAB_PREFIX}${params.toString()}`
}

export function parseSubagentTabId(tabId: string): SubagentTabRef | null {
  if (!isSubagentTabId(tabId)) return null
  const params = new URLSearchParams(tabId.slice(SUBAGENT_TAB_PREFIX.length))
  const sessionId = params.get('session')
  const agentId = params.get('agent')
  if (!sessionId || !agentId) return null
  return { sessionId, agentId, description: params.get('description') || null, agentType: params.get('type') || null }
}

/** What a sub-agent's tab is called in a strip. */
export function subagentTabTitle({ description }: Pick<SubagentTabRef, 'description'>): string {
  return description || 'Sub-agent'
}
