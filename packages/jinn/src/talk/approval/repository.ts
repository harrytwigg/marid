import type { Database } from "better-sqlite3";

export interface VoiceTranscriptInput {
  talkSessionId: string;
  browserInstanceId: string;
  credentialGeneration: number;
  providerItemId: string;
  providerEventId: string;
  transcript: string;
  recordedAt: number;
}

export interface VoiceTranscript extends VoiceTranscriptInput { inputOrdinal: number }

const text = (row: Record<string, unknown>, key: string): string => String(row[key]);

function transcriptRow(row: Record<string, unknown>): VoiceTranscript {
  return {
    talkSessionId: text(row, "talk_session_id"), browserInstanceId: text(row, "browser_instance_id"),
    credentialGeneration: Number(row.credential_generation), inputOrdinal: Number(row.input_ordinal),
    providerItemId: text(row, "provider_item_id"), providerEventId: text(row, "provider_event_id"),
    transcript: text(row, "transcript"), recordedAt: Number(row.recorded_at),
  };
}

export class TalkApprovalRepository {
  constructor(private readonly database: Database) {}

  transaction<T>(work: () => T): T { return this.database.transaction(work)(); }

  recordTranscript(input: VoiceTranscriptInput): VoiceTranscript {
    return this.transaction(() => {
      const existing = this.getTranscript(input.talkSessionId, input.credentialGeneration, input.providerItemId);
      if (existing) {
        if (existing.transcript !== input.transcript || existing.providerEventId !== input.providerEventId || existing.browserInstanceId !== input.browserInstanceId) {
          throw new Error("provider transcript identity was reused with different evidence");
        }
        return existing;
      }
      const event = this.database.prepare(`SELECT * FROM talk_voice_transcripts
        WHERE talk_session_id = ? AND credential_generation = ? AND provider_event_id = ?`)
        .get(input.talkSessionId, input.credentialGeneration, input.providerEventId) as Record<string, unknown> | undefined;
      if (event) throw new Error("provider transcript event was reused with different evidence");
      const ordinal = Number((this.database.prepare(`SELECT COALESCE(MAX(input_ordinal), 0) + 1 AS next
        FROM talk_voice_transcripts WHERE talk_session_id = ? AND credential_generation = ?`)
        .get(input.talkSessionId, input.credentialGeneration) as { next: number }).next);
      this.database.prepare(`INSERT INTO talk_voice_transcripts
        (talk_session_id, browser_instance_id, credential_generation, input_ordinal, provider_item_id,
         provider_event_id, transcript, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.talkSessionId, input.browserInstanceId, input.credentialGeneration, ordinal, input.providerItemId,
          input.providerEventId, input.transcript, input.recordedAt);
      return { ...input, inputOrdinal: ordinal };
    });
  }

  getTranscript(talkSessionId: string, generation: number, providerItemId: string): VoiceTranscript | null {
    const row = this.database.prepare(`SELECT * FROM talk_voice_transcripts
      WHERE talk_session_id = ? AND credential_generation = ? AND provider_item_id = ?`)
      .get(talkSessionId, generation, providerItemId) as Record<string, unknown> | undefined;
    return row ? transcriptRow(row) : null;
  }
}
