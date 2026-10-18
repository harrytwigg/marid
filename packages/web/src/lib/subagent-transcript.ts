import { get } from '@/lib/api'

/** `GET /api/sessions/:id/subagents/:agentId/transcript`: a background sub-agent's conversation.
 *  Mirrors the gateway's response; the two sides change together. */

export type SubagentEntry =
  | { kind: 'prompt'; text: string; at: string | null }
  | { kind: 'text'; text: string; at: string | null }
  | { kind: 'tool'; id: string; name: string; input: string; result: string | null; isError: boolean; at: string | null }

export type SubagentTranscriptUnavailable = 'no-conversation' | 'not-found' | 'unreadable'

export type SubagentTranscriptResponse =
  | { sessionId: string; agentId: string; available: false; reason: SubagentTranscriptUnavailable }
  | {
      sessionId: string
      agentId: string
      available: true
      entries: SubagentEntry[]
      /** Earlier lines were left out: the file is bigger than the part the gateway reads. */
      truncated: boolean
      /** The file's last write. */
      updatedAt: string
    }

/** The sub-agent a view opens on: the popup row's own details, which the transcript does not carry. */
export interface SubagentRef {
  id: string
  description: string | null
  agentType: string | null
}

/** How recent the file's last write must be for the sub-agent to read as working. */
export const SUBAGENT_LIVE_MS = 20_000
/** A sub-agent whose last line is its own words, and that has written nothing since, has given its answer. */
const SUBAGENT_ANSWERED_MS = 4_000

/** Whether the sub-agent is still working: it wrote recently, and has not just given its final answer. */
export function subagentIsLive(data: SubagentTranscriptResponse | undefined, now: number): boolean {
  if (!data?.available) return false
  const quiet = now - Date.parse(data.updatedAt)
  if (quiet >= SUBAGENT_LIVE_MS) return false
  return !(data.entries.at(-1)?.kind === 'text' && quiet >= SUBAGENT_ANSWERED_MS)
}

export function subagentUnavailableText(reason: SubagentTranscriptUnavailable): string {
  if (reason === 'no-conversation') return 'This session has no Claude conversation to read a sub-agent from.'
  if (reason === 'unreadable') return 'Claude Code wrote this sub-agent’s transcript, but the gateway could not read it.'
  return 'Claude Code has not written a transcript for this sub-agent, or it has been removed.'
}

/** How often to read again: quickly while the file is changing, slowly once it has gone quiet. */
export function subagentRefetchMs(data: SubagentTranscriptResponse | undefined, now: number): number {
  if (data?.available && now - Date.parse(data.updatedAt) > 5 * SUBAGENT_LIVE_MS) return 10_000
  return 2_000
}

/** A background sub-agent's conversation, read from beside the session's own transcript. */
export function getSubagentTranscript(sessionId: string, agentId: string, signal?: AbortSignal): Promise<SubagentTranscriptResponse> {
  return get<SubagentTranscriptResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/transcript`,
    signal ? { signal } : undefined,
  )
}
