import type { Message } from '@/lib/conversations'
import type { SubagentEntry } from '@/lib/subagent-transcript'

/**
 * A sub-agent's transcript as the chat's own messages, so the chat's transcript view draws it: what
 * it was asked is the user's message, what it said and each tool call are the assistant's. A call
 * reads "Using X" until its result is in, then "Used X", as a live chat's does. Ids follow the
 * entry's place in the file, which only grows, so a row keeps its identity as more arrives.
 */
export function subagentMessages(agentId: string, entries: readonly SubagentEntry[], fallbackAt: number): Message[] {
  let previous = fallbackAt - entries.length
  return entries.map((entry, index) => {
    const parsed = entry.at ? Date.parse(entry.at) : NaN
    // Timestamps only order rows and date the dividers: one without a time follows the one before it.
    const timestamp = Number.isNaN(parsed) ? previous + 1 : parsed
    previous = timestamp
    const id = `subagent:${agentId}:${index}`
    if (entry.kind === 'prompt') return { id, role: 'user', content: entry.text, timestamp }
    if (entry.kind === 'text') return { id, role: 'assistant', content: entry.text, timestamp }
    return {
      id,
      role: 'assistant',
      content: `${entry.result === null ? 'Using' : 'Used'} ${entry.name}`,
      timestamp,
      toolCall: entry.name,
      toolId: entry.id,
    }
  })
}
