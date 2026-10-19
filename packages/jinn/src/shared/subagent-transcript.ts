/**
 * A background sub-agent's conversation, read-only: the contract of
 * `GET /api/sessions/:id/subagents/:agentId/transcript`. A sub-agent is not a gateway session;
 * Claude Code writes its transcript beside the parent's, and the gateway reads it from there.
 */

export type SubagentEntry =
  /** What the sub-agent was asked: its first message. */
  | { kind: "prompt"; text: string; at: string | null }
  /** What it said. */
  | { kind: "text"; text: string; at: string | null }
  /** A tool call and, once it has come back, its result. */
  | { kind: "tool"; id: string; name: string; input: string; result: string | null; isError: boolean; at: string | null };

export type SubagentTranscriptUnavailable = "no-conversation" | "not-found" | "unreadable";

export type SubagentTranscriptResponse =
  | { sessionId: string; agentId: string; available: false; reason: SubagentTranscriptUnavailable }
  | {
      sessionId: string;
      agentId: string;
      available: true;
      entries: SubagentEntry[];
      /** Earlier lines were left out: the file is bigger than the part the gateway reads. */
      truncated: boolean;
      /** The file's last write: the sub-agent was still writing within the last few seconds of it. */
      updatedAt: string;
    };
